# team-im for Windows

This folder contains the Windows desktop workbench for the existing team-im
server. It keeps the Python server and append-only JSONL history as the source
of truth; the desktop process owns all HTTP and live-stream traffic and exposes
only a small, validated API to the sandboxed React interface.

## Current release

Version 0.2.0 is a portable Windows x64 build. Run `team-im.exe` from the
generated `out/team-im-win32-x64` folder. By default the client posts as
`operator` and connects to `http://localhost:8765`. Put a private
`team-im.local.json` beside the executable to set a locked local identity and
LAN server without committing either value:

```json
{
  "serverUrl": "http://server-on-your-lan:8765",
  "identity": "your-handle"
}
```

`TEAM_IM_SERVER` and `TEAM_IM_IDENTITY` override that file when set.

## Explicit participant controls

Opening the app starts only the lightweight Team IM server. Every managed AI
participant starts **Off** on every launch:

- Kimi, DeepSeek, and Claude API use **Enable / Disable**. Enabling arms the
  private bridge but makes no API request. A call occurs only after an explicit
  `@mention` (or after the operator deliberately inserts all active handles
  with the Council button).
- Mixed V1 Q6K and Gemma Code V2 use **Load / Unload**. Team IM checks LM
  Studio before loading and refuses to claim VRAM while another model is
  already present. A model that was already loaded elsewhere is connected to,
  not owned or unloaded by Team IM.
- Claude Code and Codex sessions stay labeled **Session based**. Their buttons
  insert mentions without pretending that Electron can start or bill those
  separate agent sessions.

The paid-API send lock remains independent of provider activation. This means
an API can be ready for the room while accidental paid mentions are still
blocked. Model-authored messages never summon another managed model.

The bridge imports provider routing from a private `delegate.py`; Team IM never
reads or stores plaintext credentials. Optional paths can be pinned alongside
the existing server settings:

```json
{
  "delegateDir": "C:\\path\\to\\local-agents",
  "lmsPath": "C:\\path\\to\\lms.exe"
}
```

## Local server supervision

When the configured server URL points at the machine the app is running on,
the app also supervises the Python server:

- **Auto-start at launch.** If nothing answers on the configured port, the app
  launches `server.py` detached (it keeps running after the app quits, because
  other machines and agents share it) and connects once it is healthy. If a
  process is holding the port without answering, the app leaves it alone and
  says so.
- **Restart server button.** The top bar gains a "Restart server" action that
  kills whatever is listening on the port and launches a fresh `server.py`.
  Other clients, including the mention bridge, reconnect on their own.
- Server stdout and stderr are appended to `server.log` beside `server.py`, so
  a server that dies on startup leaves an explanation instead of vanishing.

Supervision looks for `server.py` one level above this folder (or beside the
executable) and picks a real Python install, never the Microsoft Store stub.
Both can be pinned in `team-im.local.json`:

```json
{
  "serverScript": "C:\\path\\to\\team-im\\server.py",
  "pythonPath": "C:\\path\\to\\python.exe"
}
```

When the server lives on another machine, the button is hidden and the app
never tries to start or stop anything.

The portable executable is not code-signed or rebranded yet, so Windows may
show an unknown-publisher warning and file properties may still mention
Electron. Native Windows toast notifications are intentionally disabled in the
portable build because reliable toast delivery requires installer-created
Start Menu registration. Those are release-engineering tasks for a signed
installer, not silent promises in this build.

## Developer commands

From this directory:

```powershell
npm.cmd install --ignore-scripts
node node_modules/electron/install.js
npm.cmd run typecheck
npm.cmd test
npm.cmd run package
```

`npm.cmd start` runs the local Vite development server and Electron shell.
Production packaging always loads local files; it refuses to honor a remote
renderer URL.

## Security and dependency review

- Renderer sandboxing, context isolation, navigation blocking, and a narrow
  preload bridge are enabled.
- The packaged Content Security Policy disallows renderer network connections.
  Server traffic stays in Electron's main process.
- Incoming history and stream records are normalized before use. Message IDs,
  sender/text lengths, controls, and timestamp bounds are checked.
- The app contains no API keys. Kimi, DeepSeek, and Claude API remain private
  delegate/bridge concerns; the renderer receives status only.
- Dependencies are exact-version pinned in `package-lock.json`. The 2026-07-13
  audit reported zero known vulnerabilities across 118 resolved dependencies.
- Dependencies came from the official npm registry. Lifecycle scripts were
  disabled for the initial install. Electron's installer was inspected before
  it was run, and its downloaded Windows x64 archive matched Electron's bundled
  SHA-256 checksum.

The executable itself is unsigned. The archive checksum and npm integrity
metadata protect this local build pipeline, but they are not a substitute for
publisher code signing when distributing the app to other people.

## Honest limitations

- One channel and one locked desktop identity.
- External Claude Code and Codex presence remains session-based; the server
  does not publish real-time presence for those independent apps.
- Search and filters cover the loaded message window (up to 500), not the full
  log on disk.
- Participant activation and the paid-mention block are local to this desktop
  client. Other LAN clients can still post mentions, but a disabled bridge has
  no worker available to answer them.
- The server trusts the LAN and has no authentication. Do not expose it to the
  public internet.
