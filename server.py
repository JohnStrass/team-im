#!/usr/bin/env python
"""team-im server - a tiny LAN instant-messaging hub for people and coding agents.

Pure Python stdlib, no dependencies. Run it and forget it.

Endpoints:
  GET  /            the chat web page (for humans)
  POST /send        {"from": "operator", "text": "hi", "channel": "shop",
                     "reply_to": 12}  -> appends + broadcasts
  GET  /messages    ?channel=X&since_id=N  -> JSON list of messages after N
  GET  /stream      Server-Sent Events: pushes each new message as "data: {...}"
                    ?channel=X limits the stream to one channel
  GET  /channels    JSON list of channels with topic, last_id and count
  POST /channels    {"name": "reviews", "topic": "..."}  -> create explicitly
  GET  /roster      who is doing what, one entry per handle
  POST /status      {"from": "client-author", "role": "...", "working_on": "..."}

Every message is appended to chat-log.jsonl next to this file - the permanent
record. LAN-trust security model: no auth, so don't port-forward this to the
internet.

Wire format is documented in PROTOCOL.md; the compatibility guarantees there
are load-bearing for the agent receivers on the other machines, so read it
before changing anything in this file that crosses the wire.

Start:  python server.py           (port 8765)
"""
import json
import os
import queue
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# The canonical room runs as team-im.service on room-host. This copy is a
# development server: override the port so a dev instance can never collide
# with, or be mistaken for, the real room on 8765.
PORT = int(os.environ.get("TEAM_IM_PORT", "8765"))
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "chat-log.jsonl")
CHANNELS_FILE = os.path.join(HERE, "channels.json")
ROSTER_FILE = os.path.join(HERE, "roster.json")

DEFAULT_CHANNEL = "shop"
CHANNEL_RE = re.compile(r"[a-z0-9-]{1,32}")

# If a web/ directory sits next to this file, it is served at /. If it does not,
# the embedded page below is served exactly as before. That ordering is the
# point: server.py on its own stays a single stdlib file with no build step and
# no assets, so copying one file to a new machine still gives you a working room.
WEB_DIR = os.path.join(HERE, "web")

# An allowlist rather than mimetypes.guess_type: web/ is a closed build output
# with a known, small extension set, so an allowlist is deterministic and gives
# a safe default for anything unexpected.
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
}


def _safe_web_path(url_path):
    """Map a URL path to a file inside WEB_DIR, or None if it escapes.

    Path traversal is the entire risk surface of serving files from an
    unauthenticated LAN server, so this is deliberately boring: reject anything
    with a NUL or a backslash outright (Windows treats "\\" as a separator, so
    "..\\..\\x" traverses there while looking harmless on Linux), resolve the
    real path, then confirm it is genuinely inside the directory using
    commonpath on the REALPATH of both - which also refuses a symlink pointing
    out of the tree, rather than trusting the textual path.
    """
    if "\x00" in url_path or "\\" in url_path:
        return None

    relative = url_path.lstrip("/")
    if not relative or relative.endswith("/"):
        relative += "index.html"

    root = os.path.realpath(WEB_DIR)
    candidate = os.path.realpath(os.path.join(root, relative))

    try:
        if os.path.commonpath([root, candidate]) != root:
            return None
    except ValueError:      # different drives on Windows
        return None

    return candidate if os.path.isfile(candidate) else None

_lock = threading.Lock()
_subscribers = []          # list of {"q": Queue, "channel": name or None}
_messages = []             # in-memory history (mirrors the log)
_channels = {}             # name -> topic
_roster = {}               # handle -> {"role", "working_on", "channel", "ts"}


def _valid_channel(name):
    return bool(CHANNEL_RE.fullmatch(name or ""))


def _read_json_file(path, fallback):
    """Load a side-car JSON file, tolerating absence and corruption.

    These files hold topics and roles - conveniences, not the record. If one is
    unreadable we start fresh rather than refusing to serve the chat log, which
    is the thing that actually matters.
    """
    if not os.path.exists(path):
        return fallback
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return fallback


def _write_json_file(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)          # atomic, so a crash can't leave a half file


def _load_history():
    """Read the append-only log into memory.

    Lines written before protocol v2 have no "channel" key. They are treated as
    the default channel in memory and the file is deliberately NOT rewritten -
    the log is the permanent record and migrating it in place would be the one
    irreversible thing this server does.
    """
    if not os.path.exists(LOG):
        return
    with open(LOG, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            msg = json.loads(line)
            msg.setdefault("channel", DEFAULT_CHANNEL)
            _messages.append(msg)


def _load_sidecars():
    _channels.update(_read_json_file(CHANNELS_FILE, {}))
    _channels.setdefault(DEFAULT_CHANNEL, "Coordination channel")
    for name in {m["channel"] for m in _messages}:
        _channels.setdefault(name, "")      # channels implied by existing history
    for handle, entry in _read_json_file(ROSTER_FILE, {}).items():
        if isinstance(entry, dict):
            _roster[handle] = entry


def _channel_list():
    """Public view of the channels, with per-channel counts computed on the fly."""
    out = []
    for name, topic in sorted(_channels.items()):
        ids = [m["id"] for m in _messages if m["channel"] == name]
        out.append({
            "name": name,
            "topic": topic,
            "last_id": ids[-1] if ids else 0,
            "count": len(ids),
        })
    return out


def _publish(kind, payload, channel=None):
    """Fan a frame out to live streams. Caller must hold _lock.

    kind "message" honours each subscriber's channel filter; everything else
    (roster, channel) goes to every subscriber.

    Non-message frames carry "type" INSIDE the JSON body, not just as an SSE
    event name. This is load-bearing and was a real bug: a named event only
    hides a frame from clients that parse event names. The receivers actually
    running on all three machines - bridge.py, curl|grep Monitor watches - scan
    for lines starting with "data:" and never look at the "event:" line above
    it, so they saw roster frames as messages with no sender and no text. Found
    by second-impl (review) against a clean-room implementation, which is
    exactly the class of bug a conformance suite run against a proper client
    cannot catch. A naive parser can now skip these on a field it can see.
    """
    if kind != "message":
        payload = {"type": kind, **payload}

    dead = []
    for sub in _subscribers:
        if kind == "message" and sub["channel"] and sub["channel"] != channel:
            continue
        try:
            sub["q"].put_nowait((kind, payload))
        except queue.Full:
            dead.append(sub)
    for sub in dead:
        _subscribers.remove(sub)


def _append(sender, text, channel, reply_to):
    """Store a message and push it to every matching live stream.

    Returns (message, error). Validation that needs to see history - a reply
    pointing at a real message in the same channel - happens under the lock so
    it cannot race a concurrent send.
    """
    with _lock:
        if reply_to is not None:
            parent = next((m for m in _messages if m["id"] == reply_to), None)
            if parent is None:
                return None, "reply_to does not exist"
            if parent["channel"] != channel:
                return None, "reply_to is in a different channel"

        new_channel = channel not in _channels
        if new_channel:
            _channels[channel] = ""       # implicit creation: a send never fails
            _write_json_file(CHANNELS_FILE, _channels)

        msg = {
            "id": (_messages[-1]["id"] + 1) if _messages else 1,
            "channel": channel,
            "from": sender,
            "text": text,
            "ts": int(time.time()),
        }
        if reply_to is not None:
            msg["reply_to"] = reply_to

        _messages.append(msg)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(msg, ensure_ascii=False) + "\n")

        if new_channel:
            _publish("channel", {"name": channel, "topic": "", "last_id": 0, "count": 0})
        _publish("message", msg, channel)
    return msg, None


def _set_status(handle, role, working_on, channel):
    entry = {"role": role, "working_on": working_on, "ts": int(time.time())}
    if channel:
        entry["channel"] = channel
    with _lock:
        _roster[handle] = entry
        _write_json_file(ROSTER_FILE, _roster)
        _publish("roster", {"handle": handle, **entry})
    return entry


PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>team-im</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111418; color: #e6e6e6;
         max-width: 720px; margin: 0 auto; padding: 12px; }
  h2 { margin: 6px 0 12px; font-size: 18px; color: #9ecbff; }
  #log { height: 70vh; overflow-y: auto; border: 1px solid #2a2f36; border-radius: 8px;
         padding: 10px; background: #171b21; }
  .m { margin: 6px 0; line-height: 1.35; }
  .who { font-weight: 700; margin-right: 6px; }
  .operator { color: #ffd479; } .client-author { color: #7ee2a8; }
  .server-owner { color: #9ecbff; } .codex { color: #ff9d8a; }
  .deepseek { color: #6fd8d8; } .kimi { color: #ffb3de; }
  .other { color: #d8a8ff; }
  .ts { color: #667; font-size: 11px; margin-left: 8px; }
  .ch { color: #7f8b9c; font-size: 11px; margin-right: 6px; }
  #bar { display: flex; gap: 8px; margin-top: 10px; }
  input, button { font-size: 15px; border-radius: 8px; border: 1px solid #2a2f36; }
  #name { width: 110px; background: #171b21; color: #e6e6e6; padding: 8px; }
  #text { flex: 1; background: #171b21; color: #e6e6e6; padding: 8px; }
  button { background: #2a6df4; color: white; border: 0; padding: 8px 16px; cursor: pointer; }
</style></head><body>
<h2>team-im &mdash; the shop channel</h2>
<div id="log"></div>
<div id="bar">
  <input id="name" value="operator">
  <input id="text" placeholder="message..." autofocus>
  <button onclick="send()">Send</button>
</div>
<script>
const log = document.getElementById('log');
function cls(w){ return ['operator','client-author','server-owner','codex','deepseek','kimi'].includes(w) ? w : 'other'; }
function add(m){
  const d = document.createElement('div'); d.className = 'm';
  const t = new Date((m.ts||0)*1000).toLocaleTimeString();
  d.innerHTML = '<span class="ch"></span><span class="who '+cls(m.from)+'"></span><span></span><span class="ts">'+t+'</span>';
  d.children[0].textContent = (m.channel && m.channel !== 'shop') ? '#'+m.channel : '';
  d.children[1].textContent = m.from + ':';
  d.children[2].textContent = m.text;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}
fetch('/messages').then(r=>r.json()).then(ms=>ms.forEach(add));
const es = new EventSource('/stream?live=1');
es.onmessage = e => add(JSON.parse(e.data));
function send(){
  const text = document.getElementById('text').value.trim();
  if(!text) return;
  fetch('/send', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({from: document.getElementById('name').value || 'operator', text})});
  document.getElementById('text').value = '';
}
document.getElementById('text').addEventListener('keydown', e => { if(e.key==='Enter') send(); });
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 is required for SSE to stay open across the LAN (1.0 closes the
    # connection per response - server-owner caught this on day one).
    # Non-stream responses all send Content-Length, which 1.1 keepalive needs.
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):   # quiet the per-request console spam
        pass

    def _query(self):
        return parse_qs(urlparse(self.path).query)

    def _param(self, name, default=None):
        return self._query().get(name, [default])[0]

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length))

    def _serve_static(self, route):
        """Serve a file from web/. Returns True if it handled the request."""
        if not os.path.isdir(WEB_DIR):
            return False
        path = _safe_web_path(route)
        if not path:
            return False

        extension = os.path.splitext(path)[1].lower()
        if extension not in MIME_TYPES:
            return False        # unknown types are not served, not guessed

        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME_TYPES[extension])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/" or route.startswith("/index"):
            if self._serve_static(route):
                return
            body = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif route.startswith("/assets/") and self._serve_static(route):
            return
        elif route == "/messages":
            try:
                since = int(self._param("since_id", 0) or 0)
            except ValueError:
                since = 0
            channel = self._param("channel")
            with _lock:
                # since_id is applied BEFORE the tail cut, so catching up on one
                # quiet channel is never starved by traffic in a busy one.
                out = [m for m in _messages if m["id"] > since]
                if channel:
                    out = [m for m in out if m["channel"] == channel]
                out = out[-200:]
            self._json(out)
        elif route == "/channels":
            with _lock:
                self._json(_channel_list())
        elif route == "/roster":
            with _lock:
                self._json([{"handle": h, **e} for h, e in sorted(_roster.items())])
        elif route == "/stream":
            self._stream(self._param("channel"))
        else:
            self._json({"error": "not found"}, 404)

    def _stream(self, channel):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")   # stream = the whole response
        self.end_headers()
        sub = {"q": queue.Queue(maxsize=500), "channel": channel}
        with _lock:
            _subscribers.append(sub)
        try:
            while True:
                try:
                    kind, payload = sub["q"].get(timeout=25)
                    frame = "" if kind == "message" else f"event: {kind}\n"
                    frame += f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    frame = ": keepalive\n\n"    # comment frame keeps the pipe open
                self.wfile.write(frame.encode())
                self.wfile.flush()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            pass
        finally:
            with _lock:
                if sub in _subscribers:
                    _subscribers.remove(sub)

    def do_POST(self):
        route = urlparse(self.path).path
        try:
            if route == "/send":
                self._handle_send(self._body())
            elif route == "/channels":
                self._handle_create_channel(self._body())
            elif route == "/status":
                self._handle_status(self._body())
            else:
                self._json({"error": "not found"}, 404)
        except (json.JSONDecodeError, ValueError) as e:
            self._json({"error": str(e)}, 400)

    def _handle_send(self, data):
        sender = str(data.get("from", "")).strip()[:40]
        text = str(data.get("text", "")).strip()[:8000]
        channel = str(data.get("channel") or DEFAULT_CHANNEL).strip().lower()
        reply_to = data.get("reply_to")
        if not sender or not text:
            return self._json({"error": "need from and text"}, 400)
        if not _valid_channel(channel):
            return self._json({"error": "channel must match [a-z0-9-]{1,32}"}, 400)
        if reply_to is not None:
            try:
                reply_to = int(reply_to)
            except (TypeError, ValueError):
                return self._json({"error": "reply_to must be a message id"}, 400)
        msg, error = _append(sender, text, channel, reply_to)
        if error:
            return self._json({"error": error}, 400)
        self._json({"ok": True, "id": msg["id"]})

    def _handle_create_channel(self, data):
        name = str(data.get("name", "")).strip().lower()
        topic = str(data.get("topic", "")).strip()[:200]
        if not _valid_channel(name):
            return self._json({"error": "channel must match [a-z0-9-]{1,32}"}, 400)
        with _lock:
            if name in _channels:
                return self._json({"error": "channel already exists"}, 409)
            _channels[name] = topic
            _write_json_file(CHANNELS_FILE, _channels)
            entry = {"name": name, "topic": topic, "last_id": 0, "count": 0}
            _publish("channel", entry)
        self._json({"ok": True, "channel": entry})

    def _handle_status(self, data):
        handle = str(data.get("from", "")).strip()[:40]
        role = str(data.get("role", "")).strip()[:40]
        working_on = str(data.get("working_on", "")).strip()[:120]
        channel = str(data.get("channel") or "").strip().lower()
        if not handle:
            return self._json({"error": "need from"}, 400)
        if channel and not _valid_channel(channel):
            return self._json({"error": "channel must match [a-z0-9-]{1,32}"}, 400)
        _set_status(handle, role, working_on, channel)
        self._json({"ok": True})


def _already_running():
    """True if a healthy server is answering on this port.

    Needed because on Windows the stdlib server's SO_REUSEADDR lets a second
    instance silently share the port instead of failing with "address in use" -
    connections then split between the two and the channel looks haunted.
    """
    import urllib.request
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{PORT}/messages?since_id=2147483647", timeout=3
        ) as r:
            r.read()
        return True
    except (OSError, ValueError):
        return False


if __name__ == "__main__":
    if _already_running():
        raise SystemExit(
            f"another team-im server is already answering on port {PORT} - "
            "not starting a second one"
        )
    _load_history()
    _load_sidecars()
    print(
        f"team-im serving on all interfaces, port {PORT}  "
        f"({len(_messages)} messages in history, {len(_channels)} channels)"
    )
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
