"""Verify that bot replies come back in the channel the mention was posted in.

This drives the real bridge.py against a real server.py, both started here on a
private port in a temp directory, with a stub delegate module standing in for
the model workers. Nothing paid is called.

The defect this exists to catch: bridge.py's send() omitted "channel", so the
server applied its default and a bot mentioned in #reviews answered in #shop.
A unit test of send() alone would not have caught it - the bug was that the
caller never passed the source channel through - so this test asserts the
observable outcome instead: where each reply actually landed, and which mention
it was answering.

Three properties this harness has to hold, each of which it failed to hold in
its first version and each of which was demonstrated with a mutant rather than
argued about:

  1. Every reply is matched to ITS OWN mention. Checking the set of channels
     that got used lets two swapped replies cancel out and report success.
  2. The server under test is provably the scratch server. server.py exits
     cleanly when it finds a healthy room already on its port, so a readiness
     probe that only asks "is something answering?" can silently run the whole
     suite against a real room and write fake rows into its log.
  3. The bridge under test writes its diagnostics to scratch. bridge.py fixes
     bridge.log beside itself, so launching the repository copy pollutes the
     operational log with stub traffic.

Run it from the team-im folder:  python bridge-test.py
Exits non-zero if any check fails.
"""
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
failures = []
checks = 0
BASE = ""

# A worker whose model name starts with this is made to raise, so the failure
# path - which posts its own message from different code - is covered too.
FAIL_MARKER = "stub-fail"

# The stub echoes the last transcript line back, which is the mention that
# triggered it. That is what lets each reply be matched to its own mention
# instead of to a bare count of replies.
STUB_DELEGATE = f'''"""Stub worker table for bridge-test.py. No provider is contacted."""

WORKERS = {{
    "helper": {{"model": "stub-ok"}},
    "scout": {{"model": "{FAIL_MARKER}"}},
    "deepseek": {{"model": "stub-paid"}},
}}


def call_lmstudio(worker, system, user, temp=0.5):
    if worker["model"].startswith("{FAIL_MARKER}"):
        raise RuntimeError("stub provider is unavailable")
    # The bridge puts the triggering mention last in the transcript. Echo it so
    # the test can tell which mention this reply is answering. The "@" is
    # stripped so an echoed handle can never read as a fresh mention.
    lines = [line for line in user.splitlines() if line.strip()]
    trigger = lines[-1].replace("@", "") if lines else "(empty transcript)"
    return (f"stub reply | {{trigger}}", 3)


def call_anthropic(worker, system, user, temp=0.5):
    raise RuntimeError("no paid provider in tests")


def call_cloud(worker, system, user, temp=0.5):
    # SUCCEEDS on purpose. If this raised, the bridge would post a failure
    # notice and "a paid bot spoke" would be indistinguishable from "a paid bot
    # was woken and failed" - so the exclusion test could pass while the
    # exclusion was broken. Any message from this handle means it was woken.
    return ("stub PAID reply - this handle should not have been woken", 3)
'''


def check(name, condition, detail=""):
    global checks
    checks += 1
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        failures.append(name)


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read())


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def free_port():
    """Ask the OS for a port nobody is using, rather than hoping about one."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def mention(text, channel):
    """Post a mention and return the id it landed at."""
    status, body = post("/send", {"from": "tester", "text": text, "channel": channel})
    if status != 200:
        raise RuntimeError(f"scratch server rejected a mention: {status} {body}")
    return body["id"]


def collect(sender, after_id, count, timeout=25):
    """Wait for `count` messages from `sender`, newest history wins. Returns
    them in id order, or fewer than asked for if the timeout expires."""
    deadline = time.time() + timeout
    found = {}
    while time.time() < deadline and len(found) < count:
        for m in get(f"/messages?since_id={after_id}"):
            if m["from"] == sender:
                found[m["id"]] = m
        if len(found) < count:
            time.sleep(0.3)
    return [found[i] for i in sorted(found)]


def main():
    global BASE
    port = free_port()
    BASE = f"http://127.0.0.1:{port}"
    workdir = tempfile.mkdtemp(prefix="team-im-bridge-test-")

    # server.py keeps its log, channels and roster next to itself, and bridge.py
    # keeps bridge.log next to itself. Copying BOTH into the temp directory is
    # what keeps this run from touching the rig's operational files.
    shutil.copy(os.path.join(HERE, "server.py"), workdir)
    shutil.copy(os.path.join(HERE, "bridge.py"), workdir)
    with open(os.path.join(workdir, "delegate.py"), "w", encoding="utf-8") as f:
        f.write(STUB_DELEGATE)

    # Identity has to be something only this run could know. "The history is
    # empty" is a property a real room can also have, and the port was released
    # before the child bound it, so another server can answer in the gap.
    sentinel = {"id": 1, "from": "sentinel", "ts": 0,
                "text": f"scratch-server nonce {secrets.token_hex(16)}"}
    with open(os.path.join(workdir, "chat-log.jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps(sentinel) + "\n")

    server = bridge = None
    try:
        repo_bridge = sha256(os.path.join(HERE, "bridge.py"))
        scratch_bridge = sha256(os.path.join(workdir, "bridge.py"))

        print(f"bridge routing checks against {BASE}")
        print(f"bridge.py under test: sha256 {scratch_bridge[:16]}...")
        check("the bridge under test is byte-identical to the repository file",
              repo_bridge == scratch_bridge,
              f"repo {repo_bridge[:16]} != scratch {scratch_bridge[:16]}")

        server = subprocess.Popen(
            [sys.executable, "server.py"],
            cwd=workdir,
            env={**os.environ, "TEAM_IM_PORT": str(port)},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        history = None
        for _ in range(60):
            # server.py exits 0 when it finds a healthy room already on its
            # port. Without this the suite would happily adopt that room.
            if server.poll() is not None:
                print(f"FAIL: the scratch server exited during startup "
                      f"(code {server.returncode}) - is {port} occupied?")
                return 1
            try:
                history = get("/messages?since_id=0")
                break
            except Exception:
                time.sleep(0.2)
        if history is None:
            print(f"FAIL: no scratch server on {BASE} after 12s")
            return 1

        # Identity, not liveness, and by nonce rather than by shape. The child
        # is polled again AFTER the answer: polling only before it leaves a
        # window where a decoy replies while our own child is still starting.
        answered = [{k: m.get(k) for k in ("id", "from", "text")} for m in history]
        expected = [{k: sentinel[k] for k in ("id", "from", "text")}]
        if answered != expected or server.poll() is not None:
            print(f"FAIL: {BASE} did not answer with this run's nonce, so it is "
                  f"not our scratch server. Refusing to write to it.")
            print(f"  expected {expected}")
            print(f"  got      {answered}")
            return 1
        check("the server under test answered with this run's nonce",
              answered == expected)

        post("/channels", {"name": "reviews", "topic": "routing regression"})

        bridge = subprocess.Popen(
            [sys.executable, "bridge.py"],
            cwd=workdir,
            env={
                **os.environ,
                "TEAM_IM_SERVER": BASE,
                "TEAM_IM_ENABLED_BOTS": "atlas,scout,deepseek",
                "TEAM_IM_DELEGATE_DIR": workdir,
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        # The bridge starts from the current end of history on purpose, so every
        # mention below has to be posted after it is watching.
        time.sleep(2.5)
        if bridge.poll() is not None:
            print("FAIL: bridge exited at startup:")
            print(bridge.communicate()[0])
            return 1

        # 1. The defect itself: a mention in a non-default channel.
        first = mention("@atlas probe-alpha", "reviews")
        got = collect("atlas", first, 1)
        check("a mention in #reviews is answered", len(got) == 1)
        if got:
            check("the reply lands in #reviews, not #shop",
                  got[0]["channel"] == "reviews", f'got #{got[0]["channel"]}')
            check("the reply is answering that mention",
                  "probe-alpha" in got[0]["text"], got[0]["text"])

        # 2. The failure path posts its own message and must route the same way.
        second = mention("@scout probe-beta", "reviews")
        got = collect("scout", second, 1)
        check("a provider failure still answers", len(got) == 1)
        if got:
            check("the bridge-error notice lands in #reviews",
                  got[0]["channel"] == "reviews", f'got #{got[0]["channel"]}')
            check("the notice names no provider internals",
                  "stub provider is unavailable" not in got[0]["text"],
                  got[0]["text"])

        # 3. The default channel must keep working. This path was never broken,
        #    and a fix that read the wrong field could still break it.
        third = mention("@atlas probe-gamma", "shop")
        got = collect("atlas", third, 1)
        check("a mention in #shop is answered", len(got) == 1)
        if got:
            check("the reply stays in #shop",
                  got[0]["channel"] == "shop", f'got #{got[0]["channel"]}')

        # 4. Two channels in flight. Each reply must be matched to ITS OWN
        #    mention: checking only which channels got used lets two swapped
        #    replies cancel out, which is how the first version of this test
        #    reported 9/9 against a deliberately mis-routing mutant.
        fourth = mention("@atlas probe-delta", "reviews")
        mention("@atlas probe-epsilon", "shop")
        got = collect("atlas", fourth - 1, 2)
        check("both interleaved mentions are answered", len(got) == 2,
              f"got {len(got)}")
        routed = {token: m["channel"]
                  for m in got
                  for token in ("probe-delta", "probe-epsilon")
                  if token in m["text"]}
        check("the #reviews mention is answered in #reviews",
              routed.get("probe-delta") == "reviews", str(routed))
        check("the #shop mention is answered in #shop",
              routed.get("probe-epsilon") == "shop", str(routed))

        # 5. @everyone reaches the free local models and NOT the paid ones.
        #    The paid stub SUCCEEDS, so any message from it means it was woken.
        fifth = mention("@everyone probe-zeta", "reviews")
        free = collect("atlas", fifth, 1)
        check("@everyone wakes a free local model", len(free) == 1)
        if free:
            check("the @everyone reply lands in the source channel",
                  free[0]["channel"] == "reviews", f'got #{free[0]["channel"]}')
        # scout is enabled and free, so it must be woken too - a fix that only
        # ever woke the first free bot would otherwise pass.
        check("@everyone wakes EVERY free model, not just one",
              len(collect("scout", fifth, 1)) == 1)
        # Give a wrongly-woken paid bot time to answer before declaring silence,
        # otherwise this asserts nothing but that paid calls are slower.
        time.sleep(3)
        check("@everyone does NOT wake a PAID model",
              len(collect("deepseek", fifth, 1, timeout=1)) == 0,
              "a paid handle replied to @everyone")

        # 6. A model-authored @everyone must wake nobody. This is the loop guard
        #    and it is the difference between a feature and a bill.
        sixth = mention("@everyone probe-eta", "reviews")
        before = len(collect("atlas", sixth, 1))
        _, body = post("/send", {"from": "atlas", "text": "@everyone probe-theta",
                                 "channel": "reviews"})
        time.sleep(3)
        check("a bot-authored @everyone wakes nobody",
              len(collect("atlas", body["id"], 1, timeout=1)) == 0
              and len(collect("scout", body["id"], 1, timeout=1)) == 0,
              "a model-authored @everyone triggered a wake")
        check("the operator's own @everyone still worked in that pair", before == 1)

        # The bridge's own diagnostics must have gone to scratch, not to the
        # operational log the rig reads when something is actually wrong.
        check("the test wrote no lines to the repository bridge.log",
              os.path.exists(os.path.join(workdir, "bridge.log")))

        print(f"\n{checks - len(failures)}/{checks} checks passed")
        if failures:
            print("failed: " + ", ".join(failures))
        return 1 if failures else 0
    finally:
        for proc in (bridge, server):
            if proc and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()   # kill() only signals; reap it or it lingers
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
