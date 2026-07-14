#!/usr/bin/env python
"""Put optional cloud-model workers on the team-im channel.

The bridge watches the live stream and invokes a worker only when its handle is
mentioned. Worker-authored messages cannot invoke another worker, preventing
automatic paid-call loops.

Run it from the team-im folder with the same Python as the server. Set
TEAM_IM_DELEGATE_DIR to the directory containing a compatible delegate.py.
That worker owns provider configuration and credentials; this bridge never
stores or prints them.
"""
import json
import os
import re
import sys
import time
import urllib.request

# ---------------------------------------------------------------- config ---

SERVER = "http://localhost:8765"          # the team-im server this bridge serves
HERE = os.path.dirname(os.path.abspath(__file__))
LOGFILE = os.path.join(HERE, "bridge.log")

# Borrow the worker table and cloud caller from an explicitly configured
# delegate module. The path stays local and never enters source control.
DELEGATE_DIR = os.environ.get("TEAM_IM_DELEGATE_DIR", "").strip()
if not DELEGATE_DIR:
    raise SystemExit("Set TEAM_IM_DELEGATE_DIR to the directory containing delegate.py")
sys.path.insert(0, DELEGATE_DIR)
try:
    from delegate import WORKERS, call_cloud  # noqa: E402  (configured import path)
except Exception:
    raise SystemExit("Unable to load the configured delegate module") from None

# The two channel bots. We copy delegate's config but override two things:
#  - deepseek: use the fast/cheap "deepseek-chat" model instead of the slow
#    "deepseek-reasoner" (a chat channel wants snappy, not deep-think).
#  - max_tokens: capped low; these are chat replies, not essays.
BOTS = {
    "deepseek": {**WORKERS["deepseek"], "model": "deepseek-chat", "max_tokens": 1000},
    "kimi":     {**WORKERS["kimi"], "max_tokens": 1000},
}

MENTION = re.compile(r"@(deepseek|kimi)\b", re.IGNORECASE)
HISTORY_LINES = 25    # how many recent messages each bot sees as context

SYSTEM = (
    "You are {name}, a member of a small team coordination chat called team-im. "
    "The team: operator (the human), rig-claude and littleguy-claude "
    "(Claude Code agents on two machines), codex (OpenAI coding agent), and the "
    "cloud models deepseek and kimi (that's you and your counterpart). "
    "You were @mentioned in the latest message, shown at the end of the chat "
    "history below. Reply to it briefly and conversationally - a few sentences, "
    "plain text, no markdown formatting. You are a colleague on this channel, "
    "not a service."
)


def log(text):
    """Append one timestamped line to bridge.log (and echo to console)."""
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {text}"
    print(line, flush=True)
    with open(LOGFILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


# ------------------------------------------------------- talking to team-im ---

def get_messages(since_id=0):
    with urllib.request.urlopen(f"{SERVER}/messages?since_id={since_id}", timeout=15) as r:
        return json.loads(r.read())


def send(sender, text):
    body = json.dumps({"from": sender, "text": text[:7900]}).encode()
    req = urllib.request.Request(f"{SERVER}/send", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


# ------------------------------------------------------------ bot replies ---

def handle_mentions(msg, history):
    """If msg @mentions a bot, get that bot's reply and post it."""
    if msg["from"] in BOTS:          # anti-loop: bots never trigger bots
        return
    for name in {m.lower() for m in MENTION.findall(msg["text"])}:
        w = BOTS[name]
        # Build the context the model sees: recent chat as "name: text" lines.
        transcript = "\n".join(f'{m["from"]}: {m["text"]}' for m in history[-HISTORY_LINES:])
        log(f"@{name} mentioned by {msg['from']} (msg {msg['id']}) - calling {w['model']}")
        try:
            reply, toks = call_cloud(w, SYSTEM.format(name=name),
                                     f"Chat history:\n{transcript}", temp=0.7)
            send(name, reply)
            log(f"{name} replied ({toks} tokens)")
        except Exception as error:
            # Post the failure to the channel so mentions never vanish silently.
            # Provider errors can contain credentials or private paths.
            send(name, f"(bridge error - provider unavailable for {w['model']})")
            log(f"{name} FAILED: {type(error).__name__}")


# ------------------------------------------------------------- main loop ---

def main():
    # Start from the current end of history: old messages never trigger replies
    # (imagine restarting the bridge and it re-answers last week's mentions...).
    history = get_messages()
    last_id = history[-1]["id"] if history else 0
    log(f"bridge up - watching {SERVER}, starting after message {last_id}")

    while True:   # outer loop = reconnect forever if the stream drops
        try:
            # First, catch up on anything posted while we were disconnected.
            for m in get_messages(since_id=last_id):
                history.append(m)
                last_id = m["id"]
                handle_mentions(m, history)

            # Then sit on the live stream. The server sends a keepalive every
            # 25s, so a 60s read timeout means "connection is actually dead".
            req = urllib.request.Request(f"{SERVER}/stream?live=1")
            with urllib.request.urlopen(req, timeout=60) as stream:
                for raw in stream:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue          # keepalive comment frame - ignore
                    m = json.loads(line[5:])
                    if m["id"] <= last_id:
                        continue
                    history.append(m)
                    history[:] = history[-200:]   # don't grow forever
                    last_id = m["id"]
                    handle_mentions(m, history)
        except KeyboardInterrupt:
            log("bridge stopped by hand")
            return
        except Exception as error:
            log(f"stream dropped ({type(error).__name__}) - reconnecting in 5s")
            time.sleep(5)


if __name__ == "__main__":
    main()
