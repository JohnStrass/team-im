"""Verify team-im protocol v2, especially the backward-compatibility promises.

Run against a live server. Exits non-zero if any check fails.
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

# Defaults to the development port. run-tests.py overrides this to point at a
# throwaway server it seeds and tears down, so the suite is repeatable and
# cannot write into whichever server happens to be listening. 8765 is the room;
# nothing here should ever reach it.
BASE = os.environ.get("TEAM_IM_TEST_BASE", "http://127.0.0.1:8766").rstrip("/")
failures = []
checks = 0


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


class StreamReader(threading.Thread):
    """A deliberately v1-style reader: splits on 'data:' and ignores everything else."""

    def __init__(self, path):
        super().__init__(daemon=True)
        self.path = path
        self.data_frames = []
        self.named_events = []
        self.raw = []

    def run(self):
        try:
            with urllib.request.urlopen(BASE + self.path, timeout=20) as s:
                for raw in s:
                    line = raw.decode("utf-8", "replace").strip()
                    self.raw.append(line)
                    if line.startswith("event:"):
                        self.named_events.append(line[6:].strip())
                    elif line.startswith("data:"):
                        self.data_frames.append(json.loads(line[5:]))
        except Exception:
            pass


print("\n== guarantee 3: existing log parses, old lines default to shop ==")
history = get("/messages?since_id=0")
check("history loaded", len(history) > 0, f"got {len(history)}")
check("every message has a channel", all("channel" in m for m in history))
old = [m for m in history if m["id"] <= 63]
check("pre-v2 messages defaulted to shop", old and all(m["channel"] == "shop" for m in old))

print("\n== guarantee 5: ids stay globally monotonic ==")
ids = [m["id"] for m in history]
check("ids strictly increasing", all(b > a for a, b in zip(ids, ids[1:])))
base_id = ids[-1]

print("\n== streams attach (v1-style reader on /stream, filtered reader on ?channel=) ==")
v1_reader = StreamReader("/stream?live=1")
filtered = StreamReader("/stream?channel=reviews")
v1_reader.start()
filtered.start()
time.sleep(1.2)

print("\n== guarantee 1: a v1 sender still works ==")
status, body = post("/send", {"from": "compat-test", "text": "v1 shaped send"})
check("v1 send accepted", status == 200 and body.get("ok"), str(body))
v1_id = body.get("id")
msg = [m for m in get(f"/messages?since_id={base_id}") if m["id"] == v1_id][0]
check("v1 send landed in shop", msg["channel"] == "shop", msg.get("channel"))

print("\n== channels ==")
status, body = post("/channels", {"name": "reviews", "topic": "Code review handoffs"})
check("explicit create ok", status == 200, str(body))
status, body = post("/channels", {"name": "reviews", "topic": "dup"})
check("duplicate create -> 409", status == 409, str(status))
status, body = post("/send", {"from": "compat-test", "text": "implicit", "channel": "adhoc"})
check("implicit create on send", status == 200, str(body))
names = {c["name"] for c in get("/channels")}
check("channels listed", {"shop", "reviews", "adhoc"} <= names, str(names))
status, body = post("/send", {"from": "compat-test", "text": "x", "channel": "Bad Name!"})
check("malformed channel -> 400", status == 400, str(body))

print("\n== replies ==")
status, body = post("/send", {"from": "compat-test", "text": "parent", "channel": "reviews"})
parent_id = body["id"]
status, body = post("/send", {"from": "compat-test", "text": "child", "channel": "reviews",
                              "reply_to": parent_id})
check("same-channel reply accepted", status == 200, str(body))
child_id = body.get("id")
status, body = post("/send", {"from": "compat-test", "text": "cross", "channel": "shop",
                              "reply_to": parent_id})
check("cross-channel reply -> 400", status == 400, str(body))
status, body = post("/send", {"from": "compat-test", "text": "ghost", "channel": "reviews",
                              "reply_to": 999999})
check("nonexistent reply -> 400", status == 400, str(body))
stored = [m for m in get("/messages?channel=reviews") if m["id"] == child_id][0]
check("reply_to persisted", stored.get("reply_to") == parent_id, str(stored))

print("\n== per-channel reads ==")
reviews = get("/messages?channel=reviews")
check("channel filter returns only that channel", all(m["channel"] == "reviews" for m in reviews))
check("since_id + channel composes",
      all(m["id"] > parent_id for m in get(f"/messages?channel=reviews&since_id={parent_id}")))

print("\n== roster ==")
status, body = post("/status", {"from": "compat-test", "role": "Verifier",
                                "working_on": "protocol v2 checks", "channel": "reviews"})
check("status accepted", status == 200, str(body))
roster = {e["handle"]: e for e in get("/roster")}
check("roster entry stored", roster.get("compat-test", {}).get("role") == "Verifier", str(roster))
check("roster carries working_on",
      roster.get("compat-test", {}).get("working_on") == "protocol v2 checks")

time.sleep(1.5)

print("\n== guarantee 2: v1 receiver on /stream sees everything, unnamed ==")
seen = {m["id"] for m in v1_reader.data_frames if isinstance(m, dict) and "id" in m}
check("v1 reader saw the shop message", v1_id in seen, str(sorted(seen)))
check("v1 reader saw the reviews message", parent_id in seen, str(sorted(seen)))
check("v1 reader saw the adhoc message", any(
    m.get("channel") == "adhoc" for m in v1_reader.data_frames if isinstance(m, dict)))

print("\n== guarantee 4: roster/channel events are NAMED so v1 can't confuse them ==")
check("named events were emitted", len(v1_reader.named_events) > 0, str(v1_reader.named_events))
check("roster event named", "roster" in v1_reader.named_events, str(v1_reader.named_events))
check("channel event named", "channel" in v1_reader.named_events, str(v1_reader.named_events))
message_frames = [m for m in v1_reader.data_frames if isinstance(m, dict) and "text" in m]
check("message frames carry no event: name (v1 onmessage still fires)",
      len(message_frames) >= 4, f"{len(message_frames)} message frames")

print("\n== guarantee 4 the hard way: a NAIVE data:-only parser must not see roster frames ==")
# This is the test that was missing. The suite above used a reader that
# understands SSE event names, so it could never catch the bug second-impl
# found (review): the receivers actually deployed here - bridge.py and
# curl|grep Monitor watches - scan for lines starting with "data:" and never
# read the "event:" line above. Model the dumbest possible receiver.
naive_frames = [
    json.loads(line[5:])
    for line in v1_reader.raw
    if line.startswith("data:")
]
check("naive parser saw some frames", len(naive_frames) > 0, str(len(naive_frames)))

# A message is a frame a naive parser would treat as chat: it has from + text.
would_post = [f for f in naive_frames if isinstance(f, dict) and "type" not in f]
phantom = [f for f in would_post if not f.get("from") or not f.get("text")]
check("no frame without a type key lacks from/text (nothing phantom to post)",
      not phantom, str(phantom[:2]))

roster_frames = [f for f in naive_frames if isinstance(f, dict) and f.get("type") == "roster"]
channel_frames = [f for f in naive_frames if isinstance(f, dict) and f.get("type") == "channel"]
check("roster frames are self-identifying via type", len(roster_frames) > 0, str(naive_frames[-2:]))
check("channel frames are self-identifying via type", len(channel_frames) > 0, str(naive_frames[-2:]))
check("message frames carry NO type key, so the guard cannot drop real chat",
      all("type" not in f for f in naive_frames
          if isinstance(f, dict) and f.get("from") and f.get("text")))

print("\n== filtered stream only wakes for its own channel ==")
fseen = [m for m in filtered.data_frames if isinstance(m, dict) and "id" in m]
check("filtered stream got reviews traffic", any(m["id"] == parent_id for m in fseen))
check("filtered stream ignored other channels",
      all(m["channel"] == "reviews" for m in fseen),
      str([m.get("channel") for m in fseen]))

print(f"\n{checks - len(failures)}/{checks} checks passed")
if failures:
    print("FAILED: " + ", ".join(failures))
    sys.exit(1)
print("all protocol v2 guarantees hold")
