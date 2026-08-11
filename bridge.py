#!/usr/bin/env python
"""Put explicitly enabled model workers on the team-im channel.

The desktop app starts this bridge only after the operator enables at least one
participant. The bridge invokes enabled workers only when their handle is
mentioned. Worker-authored messages cannot invoke another worker, preventing
automatic paid-call or local-model loops.

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

SERVER = os.environ.get("TEAM_IM_SERVER", "http://localhost:8765").rstrip("/")
HERE = os.path.dirname(os.path.abspath(__file__))
LOGFILE = os.path.join(HERE, "bridge.log")
ENABLED = {
    name.strip().lower()
    for name in os.environ.get("TEAM_IM_ENABLED_BOTS", "").split(",")
    if name.strip()
}

# Borrow the worker table and cloud caller from an explicitly configured
# delegate module. The path stays local and never enters source control.
DELEGATE_DIR = os.environ.get("TEAM_IM_DELEGATE_DIR", "").strip()
if not DELEGATE_DIR:
    raise SystemExit("Set TEAM_IM_DELEGATE_DIR to the directory containing delegate.py")
sys.path.insert(0, DELEGATE_DIR)
try:
    from delegate import WORKERS, call_anthropic, call_cloud, call_lmstudio  # noqa: E402
except Exception:
    raise SystemExit("Unable to load the configured delegate module") from None

# Output caps and a short rolling history keep routine team chat from burning
# review-model context. Local workers receive a little more room than paid APIs.
BOT_SPECS = {
    "deepseek": ("deepseek", call_cloud, {"model": "deepseek-chat", "max_tokens": 700}),
    "kimi": ("kimi", call_cloud, {"max_tokens": 700}),
    "claude-api": ("sonnet", call_anthropic, {"max_tokens": 700}),
    "atlas":    ("helper", call_lmstudio, {"max_tokens": 1100}),
    "scout":    ("scout",  call_lmstudio, {"max_tokens": 800}),
    "gemma-coder": ("gemma", call_lmstudio, {"max_tokens": 1100}),
}
ALL_BOT_HANDLES = frozenset(BOT_SPECS)

# @everyone reaches the free local models and NOT the paid APIs.
#
# Derived from the caller function rather than a hardcoded list of names: a bot
# added to BOT_SPECS later cannot silently miss the exclusion, because to be
# paid it has to be wired to a paid caller. A name list would have to be
# remembered; this cannot be forgotten.
#
# The exclusion is load-bearing, not a preference. The composer's cost warning
# comes from extractPaidAgentMentions, which matches KNOWN handles - "@everyone"
# is not one, so it produces no warning and does not trip the paid-AI block. An
# expansion that included paid models would spend money with nothing shown to
# the operator first.
PAID_CALLERS = {call_cloud, call_anthropic}
EVERYONE = "everyone"
EVERYONE_INCLUDES_PAID = os.environ.get(
    "TEAM_IM_EVERYONE_INCLUDES_PAID", ""
).strip().lower() in {"1", "true", "yes"}


def is_paid(handle):
    """True if waking this handle costs money."""
    return BOT_SPECS[handle][1] in PAID_CALLERS
BOTS = {}
for handle in ENABLED:
    if handle not in BOT_SPECS:
        continue
    worker_name, caller, overrides = BOT_SPECS[handle]
    if worker_name not in WORKERS:
        continue
    BOTS[handle] = ({**WORKERS[worker_name], **overrides}, caller)

if not BOTS:
    raise SystemExit("No supported TEAM_IM_ENABLED_BOTS were selected")

MENTION = re.compile(
    r"@(" + "|".join(
        re.escape(name)
        for name in sorted(set(BOTS) | {EVERYONE}, key=len, reverse=True)
    ) + r")\b",
    re.IGNORECASE,
)
try:
    HISTORY_LINES = max(3, min(20, int(os.environ.get("TEAM_IM_HISTORY_LINES", "12"))))
except ValueError:
    HISTORY_LINES = 12
MAX_TRANSCRIPT_CHARS = 12_000

SYSTEM = (
    "You are {name} in team-im, a small human-and-agent coordination chat. "
    "You were explicitly mentioned. Reply briefly and concretely, usually in a "
    "few sentences. Use plain text. Do not summon another agent."
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


def send(sender, text, channel=None):
    payload = {"from": sender, "text": text[:7900]}
    if channel:
        # Left out entirely when unknown, so the server picks its own default
        # rather than this bridge guessing one. A v1 server ignores the key.
        payload["channel"] = channel
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{SERVER}/send", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


# ------------------------------------------------------------ bot replies ---

def handle_mentions(msg, history):
    """If msg @mentions a bot, get that bot's reply and post it."""
    if msg["from"].lower() in ALL_BOT_HANDLES:  # bots never trigger bots
        return
    # Answer where you were asked. Without carrying this through, the server
    # applies its own default and a bot mentioned in #reviews replies in #shop.
    channel = msg.get("channel")

    names = {m.lower() for m in MENTION.findall(msg["text"])}
    if EVERYONE in names:
        # Expand here rather than in a client: the bridge is the only place that
        # knows which handles are actually enabled and which cost money, and a
        # client-side expansion would be a list of names a server has to trust.
        #
        # The loop guard above already returned for bot-authored messages, so a
        # model writing "@everyone" reaches nobody - which is the whole reason
        # that guard runs before this and not after.
        names.discard(EVERYONE)
        reachable = {h for h in BOTS if EVERYONE_INCLUDES_PAID or not is_paid(h)}
        skipped = sorted(h for h in BOTS if h not in reachable)
        names |= reachable
        log(f"@everyone from {msg['from']} -> {sorted(reachable) or 'nobody'}"
            + (f" (paid, not woken: {skipped})" if skipped else ""))

    for name in names:
        w, caller = BOTS[name]
        # Build the context the model sees: recent chat as "name: text" lines.
        transcript = "\n".join(
            f'{item["from"]}: {item["text"]}' for item in history[-HISTORY_LINES:]
        )[-MAX_TRANSCRIPT_CHARS:]
        log(f"@{name} mentioned by {msg['from']} (msg {msg['id']}) - calling {w['model']}")
        try:
            reply, toks = caller(
                w,
                SYSTEM.format(name=name),
                f"Recent chat (latest mention is last):\n{transcript}",
                temp=0.5,
            )
            send(name, reply, channel)
            log(f"{name} replied ({toks} tokens)")
        except Exception as error:
            # Post the failure to the channel so mentions never vanish silently.
            # Provider errors can contain credentials or private paths.
            send(name, f"(bridge error - provider unavailable for {w['model']})",
                 channel)
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
