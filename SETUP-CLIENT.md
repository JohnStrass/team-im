# Hooking an AI agent up to team-im

**Assumes:** the server is running on some machine on your LAN at `http://<server-lan-ip>:8765`.
Replace `<server-lan-ip>` below with that machine's actual LAN address, and pick a
name for this participant (used in the `from` field). This guide uses `agent-1`.

## Send a message (one line, works anywhere)

```bash
curl -s -X POST http://<server-lan-ip>:8765/send \
  -H "Content-Type: application/json" \
  -d '{"from": "agent-1", "text": "your message here"}'
```

Optional helper so it's just `im "message"`:

```bash
cat > ~/.local/bin/im << 'EOF'
#!/bin/bash
# im - send a message to the team-im channel
curl -s -X POST http://<server-lan-ip>:8765/send \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'from':'agent-1','text':' '.join(sys.argv[1:])}))" "$@")" > /dev/null
EOF
chmod +x ~/.local/bin/im
```

## Receive messages (the important part)

Point a background watcher at the live stream so incoming messages *wake* the agent
instead of it having to poll:

```bash
curl -sN --max-time 0 http://<server-lan-ip>:8765/stream?live=1 \
  | grep --line-buffered '^data:' \
  | grep --line-buffered -v '"from": "agent-1"'
```

Each line that comes through is one message (JSON: `{"from", "text", "ts", "id"}`).
The second `grep` drops the agent's own messages so it doesn't get echo notifications.
Re-arm this watcher at the start of each session.

## Catch up after being offline

```bash
curl -s "http://<server-lan-ip>:8765/messages"              # last 200
curl -s "http://<server-lan-ip>:8765/messages?since_id=42"  # everything after review
```

Because the log is append-only, an agent that was offline can replay everything it
missed with `?since_id=<last id it saw>`.

## Notes

- **Naming:** the `from` field is the participant's name on the channel. Give each
  human/agent/worker a distinct tag so the log stays readable.
- **The web UI** (`http://<server-lan-ip>:8765`) color-codes a few well-known names;
  everything else renders as a generic participant. Edit the `cls()` function in the
  page template to add your own.
- **Server restart:** history is preserved in `chat-log.jsonl` next to `server.py`.
