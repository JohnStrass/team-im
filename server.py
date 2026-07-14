#!/usr/bin/env python
"""team-im server - a tiny LAN instant-messaging hub for people and coding agents.

Pure Python stdlib, no dependencies. Run it and forget it.

Endpoints:
  GET  /            the chat web page (for humans)
  POST /send        {"from": "operator", "text": "hello"}  -> appends + broadcasts
  GET  /messages    ?since_id=N  -> JSON list of messages after N (polling)
  GET  /stream      Server-Sent Events: pushes each new message as "data: {...}"

Every message is appended to chat-log.jsonl next to this file - the permanent
record. LAN-trust security model: no auth, so don't port-forward this to the
internet.

Start:  python server.py           (port 8765)
"""
import json
import os
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "chat-log.jsonl")

_lock = threading.Lock()
_subscribers = []          # list of queue.Queue, one per open /stream connection
_messages = []             # in-memory history (mirrors the log)


def _load_history():
    if not os.path.exists(LOG):
        return
    with open(LOG, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                _messages.append(json.loads(line))


def _append(msg):
    """Store a message and push it to every live stream."""
    with _lock:
        msg["id"] = (_messages[-1]["id"] + 1) if _messages else 1
        _messages.append(msg)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(msg, ensure_ascii=False) + "\n")
        dead = []
        for q in _subscribers:
            try:
                q.put_nowait(msg)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _subscribers.remove(q)
    return msg


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
  .operator { color: #ffd479; } .rig-claude { color: #7ee2a8; }
  .littleguy-claude { color: #9ecbff; } .codex { color: #ff9d8a; }
  .deepseek { color: #6fd8d8; } .kimi { color: #ffb3de; }
  .other { color: #d8a8ff; }
  .ts { color: #667; font-size: 11px; margin-left: 8px; }
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
function cls(w){ return ['operator','rig-claude','littleguy-claude','codex','deepseek','kimi'].includes(w) ? w : 'other'; }
function add(m){
  const d = document.createElement('div'); d.className = 'm';
  const t = new Date((m.ts||0)*1000).toLocaleTimeString();
  d.innerHTML = '<span class="who '+cls(m.from)+'"></span><span></span><span class="ts">'+t+'</span>';
  d.children[0].textContent = m.from + ':';
  d.children[1].textContent = m.text;
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
    # connection per response - littleguy-claude caught this on day one).
    # Non-stream responses all send Content-Length, which 1.1 keepalive needs.
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):   # quiet the per-request console spam
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            body = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/messages"):
            since = 0
            if "since_id=" in self.path:
                try:
                    since = int(self.path.split("since_id=")[1].split("&")[0])
                except ValueError:
                    pass
            with _lock:
                out = [m for m in _messages if m["id"] > since][-200:]
            self._json(out)
        elif self.path.startswith("/stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")   # stream = the whole response, no keepalive reuse
            self.end_headers()
            q = queue.Queue(maxsize=500)
            with _lock:
                _subscribers.append(q)
            try:
                while True:
                    try:
                        msg = q.get(timeout=25)
                        data = f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                    except queue.Empty:
                        data = ": keepalive\n\n"    # comment frame keeps the pipe open
                    self.wfile.write(data.encode())
                    self.wfile.flush()
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
                pass
            finally:
                with _lock:
                    if q in _subscribers:
                        _subscribers.remove(q)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/send":
            try:
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length))
                sender = str(data.get("from", "")).strip()[:40]
                text = str(data.get("text", "")).strip()[:8000]
                if not sender or not text:
                    return self._json({"error": "need from and text"}, 400)
                msg = _append({"from": sender, "text": text, "ts": int(time.time())})
                self._json({"ok": True, "id": msg["id"]})
            except (json.JSONDecodeError, ValueError) as e:
                self._json({"error": str(e)}, 400)
        else:
            self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    _load_history()
    print(f"team-im serving on all interfaces, port {PORT}  ({len(_messages)} messages in history)")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
