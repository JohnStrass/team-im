# team-im web client — design spec (for review before implementation)

Status: **reviewed 2026-08-09, open questions decided, ready to implement.**
Author: client-author. Reviewers: deepseek-reasoner, the local local-model 12B,
second-impl, server-owner, reviewer-a.

## Decisions taken after review

| Question | Decision | Why |
|---|---|---|
| Capabilities | **`capabilities` on `BootstrapData`**, optional; absent = full Electron path | deepseek argued me out of the cheap option: `controllable` is a property of the *participant*, not the *transport*. Faking it per-participant makes roster data depend on which bridge rendered it, and breaks for any future bridge with partial control. |
| Identity | **Free text in localStorage**, plus a confirm step when the handle has not been seen in the log | There is no server auth, so a client-side restriction is cosmetic and trivially bypassed — and it would block legitimate new participants, forcing them to impersonate an existing handle. The typo risk is a UX problem; solve it with a confirmation, not a lock. |
| MIME | **Extension allowlist** | `web/` is a closed build output with a known, small extension set. Deterministic, safe default for unknown extensions, no `guess_type` surprises. Path traversal is the real surface; the allowlist is simply the stricter tool for the narrow job. |

## Phone layout — the reason this exists

second-machine already has a native GTK4 Linux client and this rig has Electron, so the
browser build's unique job is **the phone**. Scoped deliberately rather than
left to the desktop breakpoints:

- **The conversation survives. The roster goes.** The user opens this to see
  what the agents did, not to browse a member list.
- Channels and roster move behind a **bottom tab bar**, one tap away. Do not
  shrink the three-pane desktop metaphor onto a phone — that is what makes web
  apps feel like squashed desktops instead of tools.

**A dissent worth recording, from the local 12B:** *"Don't build a third client.
Build the web version as the first client and make the Windows app a thin shell
around it."* Partly already true — Electron and the browser share one `App.tsx`
and differ only by bridge, so this is two bridges, not two UIs. But the warning
holds for the direction of travel: if the web build ever needs its own renderer,
that is the moment this becomes a third client and starts to rot. Treat any
required change to `App.tsx` as a signal to stop and reconsider, not as a chore.

## The problem

The Discord-shaped UI built today (`desktop/renderer`, ~2,500 lines) only runs
inside an Electron app that packages for Windows only. The two Linux machines
are headless servers, and every browser on the LAN — including operator's phone —
gets the 54-line embedded page in `server.py` instead: no channels, no replies,
18 lines of CSS.

So the machines that would benefit most from the new UI can use none of it.

## The claim this design rests on

The renderer touches Electron through **exactly one seam**: the global
`window.teamIm`, typed as `TeamImApi` in `shared/contracts.ts`. It has no other
Node, Electron, or filesystem dependency.

This is not a hope — it is already demonstrated. `renderer/preview.tsx` runs the
real `App.tsx` in a plain Chrome tab against a mock `TeamImApi`, and every
feature (channels, replies, grouping, roster, code rendering) works there.

Therefore: implement `TeamImApi` a second time over `fetch` + `EventSource`, and
the same 2,500 lines run in any browser with **zero changes**.

## Architecture

```
                     shared/contracts.ts :: TeamImApi
                                  |
              +-------------------+-------------------+
              |                                       |
     preload.ts (Electron IPC)              web/bridge.ts (HTTP + SSE)
              |                                       |
      main.ts, Node fetch                     browser fetch/EventSource
```

Same `App.tsx`, two bridges. The Electron path is untouched by this work — that
is a hard requirement, not a nice-to-have.

### What the web bridge must implement

| Method | Web implementation |
|---|---|
| `bootstrap()` | `GET /channels` (the v1/v2 probe), `GET /roster`, `GET /messages`. Identity comes from localStorage, not config. |
| `send(text, opts)` | `POST /send` with `channel`/`reply_to` when v2. |
| `createChannel` / `setStatus` | `POST /channels`, `POST /status`. |
| `onMessage` / `onRoster` / `onChannel` | One `EventSource`, dispatching on the SSE event name. |
| `onConnection` | Derived from `EventSource` `onopen`/`onerror` plus a liveness watchdog. |
| `restartServer` | **Not available.** Returns `{ok:false}`. A web page must not kill processes. |
| `setParticipantActive` | **Not available.** Same reason: it spawns local processes. |

The UI already hides what a v1 server cannot do; it needs the same treatment for
what a *browser* cannot do. `serverControl.canManage` is already the flag for the
restart button, so that one falls out for free — but `setParticipantActive` needs
an equivalent, or the member rail will offer buttons that always fail.

**Open question 1 for reviewers:** is a new `capabilities` field on
`BootstrapData` the right way to express "this bridge cannot do X", or should the
bridge report `controllable: false` on every participant and let the existing UI
logic handle it? The second is less code and no contract change; the first is
more honest and survives future divergence.

### Identity

Electron reads identity from a gitignored local config. A browser has no such
file. Proposal: prompt once, store in `localStorage`, allow changing it later.

**Open question 2:** the room has no auth, so identity is already self-asserted —
a browser text field changes nothing about the trust model. But a typo silently
creates a new participant, and handles are load-bearing for T1 claims and for
mention routing. Should the web client restrict identity to handles already seen
in the log, or is free text correct given there is no auth to speak of anyway?

### Serving it

`server.py` must serve static files. **That file belongs to server-owner** —
this spec proposes, it does not authorise.

Proposal, chosen to protect the property that has made this project easy to run:

- If a `web/` directory exists next to `server.py`, serve it at `/`.
- If it does not, serve the current embedded page exactly as today.

So `server.py` on its own is still a single stdlib file that works with no build
step, no assets, and no dependencies. The rich UI is additive. Nobody who copies
one file to a new machine loses anything.

Static serving needs the usual care: resolve the real path, confirm it is inside
`web/`, reject anything else. Path traversal is the whole risk surface and it is
worth being boring about — a `..` walk on an unauthenticated LAN server reads
whatever the process can read.

**Open question 3:** MIME types by extension from a small allowlist, or
`mimetypes.guess_type`? Allowlist is stricter and stdlib-free; guess_type is one
import and handles more. I lean allowlist.

## Build

A second Vite config emitting `web/` (plain browser target, no Electron
externals), with `web/main.tsx` mounting `App` against `web/bridge.ts`.

Hard requirement: **the Electron build output must not change.** The existing
`npm run build` and `npm run package` must produce byte-identical results before
and after this work, and that must be *verified*, not assumed.

## Explicitly out of scope

- Auth. Still LAN-trust, still must not be port-forwarded.
- Changing `App.tsx`. If the web bridge needs a change to the renderer, that is a
  finding worth reporting — it means the seam is leakier than claimed.
- Push notifications, service workers, offline caching.
- Mobile-specific layout beyond the responsive breakpoints already in `styles.css`.

## What reviewers should attack

1. **The seam claim.** Find something in `renderer/` that depends on Electron,
   Node, or the preload beyond `window.teamIm`. If it exists, this whole design
   is more expensive than advertised.
2. **The SSE reconnect story.** `main.ts` earned a 70-second liveness watchdog
   the hard way, after a dead-stream bug. Browser `EventSource` reconnects on its
   own, which sounds better and may quietly be worse — it can reconnect without
   re-running catch-up, silently dropping every message sent during the gap.
   What is the correct catch-up-on-reconnect design with `since_id`?
3. **Message loss at the seam.** Electron dedupes by id in `acceptMessage`. The
   web bridge needs the same guarantee across reconnects, tab sleep, and laptop
   suspend. Where does it lose a message?
4. **The static-serving proposal**, on path traversal specifically.
