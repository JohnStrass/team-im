"""Run the team-im Python checks.

  python run-tests.py

There was no runner: bridge-test.py and protocol-test.py were standalone files
that only ran when somebody remembered their names. A regression nobody runs is
a comment.

Both suites run against throwaway servers on OS-assigned ports, so this is safe
to run repeatedly and on any machine. That is not tidiness - protocol-test.py
used to write into whatever server was listening on 8766, which meant it could
only pass once against a given server, and pointing it one digit away from 8765
would have written test traffic into the room.

The desktop client's suite is not run from here - it needs node and lives with
the code it tests:

  cd desktop && npm test && npm run typecheck
"""
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# protocol-test.py checks that rows written before protocol v2 - which have no
# "channel" key - are read back as the default channel. It identifies them as
# id <= 63, from the real log it was written against. A throwaway server needs
# a few of those present or the guarantee has nothing to verify.
#
# The nonce in the text is what makes them an identity proof rather than a
# shape: "three rows" is a property another server can also have, and the port
# is released before the child binds it, so something else can answer in that
# gap. Only this run knows this string.
def seed_rows(nonce):
    return [
        {"id": 1, "from": "seed", "ts": 0,
         "text": f"a pre-v2 row, written before channels existed [{nonce}]"},
        {"id": 2, "from": "seed", "ts": 0, "text": f"another one [{nonce}]"},
        {"id": 3, "from": "seed", "ts": 0, "text": f"and a third [{nonce}]"},
    ]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_scratch_server(seed):
    """Bring up a server.py in a temp directory on a private port.

    Returns (process, workdir, base_url), or (None, workdir, None) if it did
    not come up - and in that case the child is already stopped, because
    returning None while it is still alive orphans it past cleanup.
    """
    workdir = tempfile.mkdtemp(prefix="team-im-run-tests-")
    shutil.copy(os.path.join(HERE, "server.py"), workdir)
    with open(os.path.join(workdir, "chat-log.jsonl"), "w", encoding="utf-8") as f:
        for row in seed:
            f.write(json.dumps(row) + "\n")

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        [sys.executable, "server.py"],
        cwd=workdir,
        env={**os.environ, "TEAM_IM_PORT": str(port)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    expected = [{k: row[k] for k in ("id", "from", "text")} for row in seed]
    for _ in range(60):
        # server.py exits cleanly if it finds a healthy room already on its
        # port, so liveness alone would let this adopt somebody else's server.
        if proc.poll() is not None:
            return None, workdir, None
        try:
            history = json.loads(
                urllib.request.urlopen(f"{base}/messages?since_id=0", timeout=3).read()
            )
        except Exception:
            time.sleep(0.2)
            continue

        answered = [{k: m.get(k) for k in ("id", "from", "text")} for m in history]
        # Compare the rows, not their count, and poll the child again AFTER the
        # answer: checking only beforehand leaves a window where something else
        # replies while our own child is still in its startup preflight.
        if answered != expected or proc.poll() is not None:
            print(f"  {base} did not answer with this run's nonce, so it is not "
                  f"the server we started. Refusing to use it.")
            stop(proc, None)
            return None, workdir, None
        return proc, workdir, base

    stop(proc, None)   # never became ready, but may well still be alive
    return None, workdir, None


def stop(proc, workdir):
    """Stop a child and optionally remove its directory. workdir may be None
    when only the process needs stopping."""
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()   # kill() only signals; reap it or it lingers
    if workdir:
        shutil.rmtree(workdir, ignore_errors=True)


def run(script, env=None):
    # Flush before handing stdout to the child, or the header lands after the
    # output it is supposed to introduce.
    print(f"\n=== {script} " + "=" * max(4, 64 - len(script)), flush=True)
    return subprocess.call([sys.executable, script], cwd=HERE,
                           env={**os.environ, **(env or {})})


def main():
    results = []

    # bridge-test.py brings up its own server and bridge; it needs nothing here.
    results.append(("bridge-test.py", run("bridge-test.py")))

    proc, workdir, base = start_scratch_server(seed_rows(secrets.token_hex(16)))
    try:
        if base is None:
            print("\n=== protocol-test.py " + "=" * 44, flush=True)
            print("  FAIL - could not start a throwaway server for it.")
            results.append(("protocol-test.py", 1))
        else:
            results.append(("protocol-test.py",
                            run("protocol-test.py", {"TEAM_IM_TEST_BASE": base})))
    finally:
        stop(proc, workdir)

    print("\n" + "=" * 70)
    failed = 0
    for name, code in results:
        print(f"  {'PASS' if code == 0 else 'FAIL'}  {name}"
              + ("" if code == 0 else f" (exit {code})"))
        failed += code != 0
    print("Desktop suite is separate:  cd desktop && npm test && npm run typecheck")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
