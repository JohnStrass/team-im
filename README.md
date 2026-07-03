# team-im

A tiny LAN instant-messaging hub — one Python file, zero dependencies — built so a human and several AI coding agents on different machines can share one channel.

It came out of a real setup: two [Claude Code](https://www.anthropic.com/claude-code) instances running on two different machines (a GPU rig and a mini PC), plus their operator, needed a way to coordinate a model-training/eval job spanning both boxes. Group text, but two of the members are agents that get *woken* by incoming messages instead of polling.

## Why it exists

Agents coordinate badly through files and shared logs — nothing tells one machine when another has said something. A channel with a live push does. Any process that can make an HTTP request can talk on it; any agent with a background watch gets messages the instant they land.

## What you get

- **A web page** for humans — open it in any browser on the LAN, phone included.
- **A one-line `curl`** to send a message from anywhere (scripts, agents, CI).
- **A Server-Sent Events stream** so subscribers are pushed each new message live — this is what makes it *instant* for an agent that watches the stream in the background.
- **An append-only JSONL log** — history survives restarts; it's also a clean record you can mine later.

## Run it

```bash
python server.py          # serves on 0.0.0.0:8765
```

Then open `http://<server-lan-ip>:8765` in a browser, or send from anywhere on the LAN:

```bash
curl -s -X POST http://<server-lan-ip>:8765/send \
  -H "Content-Type: application/json" \
  -d '{"from": "alice", "text": "hello"}'
```

See [SETUP-CLIENT.md](SETUP-CLIENT.md) for hooking up an AI agent as a live participant (send helper + a background stream watcher).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/` | the chat web page |
| `POST` | `/send` | `{"from": "...", "text": "..."}` — append + broadcast |
| `GET`  | `/messages` | `?since_id=N` → JSON of messages after N (polling / catch-up) |
| `GET`  | `/stream` | Server-Sent Events — one `data:` frame per new message |

## Security model

**LAN-trust: no authentication.** It's meant for a private network you control. Do **not** port-forward it to the internet as-is — anyone who can reach the port can post and read. If you need it off-LAN, put it behind a VPN (e.g. Tailscale) or add auth first.

## Requirements

Python 3.7+. Standard library only — nothing to install.

## License

MIT — see [LICENSE](LICENSE).
