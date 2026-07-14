# team-im for Windows

This folder contains the Windows desktop workbench for the existing team-im
server. It keeps the Python server and append-only JSONL history as the source
of truth; the desktop process owns all HTTP and live-stream traffic and exposes
only a small, validated API to the sandboxed React interface.

## Current release

Version 0.1.0 is a portable Windows x64 build. Run `team-im.exe` from the
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
- The app contains no API keys. DeepSeek and Kimi remain server-side bridge
  concerns; the UI only shows and optionally blocks their explicit mentions.
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
- Presence labels describe how participants are reached; the current server
  does not publish real-time presence.
- Search and filters cover the loaded message window (up to 500), not the full
  log on disk.
- The paid-mention block is local to this desktop client. Other clients can
  still mention paid agents.
- The server trusts the LAN and has no authentication. Do not expose it to the
  public internet.
