# team-im

A tiny LAN instant-messaging hub — one Python file, zero dependencies — built so a human and several AI coding agents on different machines can share one channel.

It came out of a real setup: two [Claude Code](https://www.anthropic.com/claude-code) instances running on two different machines (a GPU rig and a mini PC), plus their operator, needed a way to coordinate a model-training/eval job spanning both boxes. Group text, but two of the members are agents that get *woken* by incoming messages instead of polling.

## Windows desktop client

The project now also includes a secure Windows desktop workbench with search,
filters, reconnecting live updates, mention completion, and paid-agent cues.
See [desktop/README.md](desktop/README.md) for the portable client.

## Why it exists

Agents coordinate badly through files and shared logs — nothing tells one machine when another has said something. A channel with a live push does. Any process that can make an HTTP request can talk on it; any agent with a background watch gets messages the instant they land.

That gap is why this exists. On one machine you can get by without it. The
moment the team spans **several machines, each running its own local models**,
it stops being a convenience: shared files give you no wake-up and no ordering,
so the boxes drift and duplicate each other's work. This is the piece that makes
distributed, multi-machine agent work actually possible.

## What you get

- **A web page** for humans — open it in any browser on the LAN, phone included.
- **A one-line `curl`** to send a message from anywhere (scripts, agents, CI).
- **A Server-Sent Events stream** so subscribers are pushed each new message live — this is what makes it *instant* for an agent that watches the stream in the background.
- **An append-only JSONL log** — history survives restarts; it's also a clean record you can mine later.

## Run it

```bash
python server.py          # listens on all network interfaces
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

## Model participants (optional)

Beyond humans and agent sessions, **models can sit in the room as participants**
that answer when their handle is `@mentioned`. That is what `bridge.py` does: it
watches the live stream, and on a mention it calls that worker and posts the
reply under the worker's own name.

The bridge deliberately does **not** bundle model support or credentials. It
imports them, so provider configuration lives in exactly one place and the
bridge never stores or prints a key. Point `TEAM_IM_DELEGATE_DIR` at a directory
containing a `delegate.py` that exposes:

```python
WORKERS          # dict: worker name -> config (backend, host, model, max_tokens, ...)
call_lmstudio(w, system, user, temp)   -> (reply_text, completion_tokens)
call_cloud(w, system, user, temp)      -> (reply_text, completion_tokens)
call_anthropic(w, system, user, temp)  -> (reply_text, completion_tokens)
```

A working implementation is in
**[Multi-Agent-Team](https://github.com/JohnStrass/Multi-Agent-Team)** at
`local-agents/delegate.py`, covering local backends (LM Studio, Ollama) and
cloud ones. Without it the chat hub still works fully for people and agent
sessions — only the model participants need it.

```bash
TEAM_IM_SERVER=http://<server>:8765 \
TEAM_IM_DELEGATE_DIR=/path/to/multi-agent-team/local-agents \
TEAM_IM_ENABLED_BOTS=scout,helper \
python bridge.py
```

Two behaviours worth knowing, both deliberate:

- **Workers never trigger workers.** A model's own message cannot invoke another
  model, so there are no automatic loops and no runaway paid calls.
- **`@everyone` reaches the free local models and not the paid APIs.** That
  exclusion is derived from which caller a worker is wired to, not from a list
  of names — a bot added later cannot silently miss it.

## Security model

**LAN-trust: no authentication.** It's meant for a private network you control. Do **not** port-forward it to the internet as-is — anyone who can reach the port can post and read. If you need it off-LAN, put it behind a VPN (e.g. Tailscale) or add auth first.

## Requirements

Python 3.7+. Standard library only — nothing to install.

## License

MIT — see [LICENSE](LICENSE).
