/**
 * Design preview harness - DEV ONLY, never shipped.
 *
 * Mounts the real App against a fake window.teamIm so the UI can be reviewed in
 * a plain browser without Electron, a server, or the LAN. The fixture data is
 * shaped like real room traffic (long agent reviews, pasted code, replies,
 * roster lines both fresh and stale) because a UI that only looks right on
 * "hello world" is not verified.
 *
 * Served by Vite at /preview.html. The packaged app builds index.html only.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type {
  BootstrapData,
  Channel,
  ChannelResult,
  ChatMessage,
  ParticipantActionResult,
  ParticipantState,
  RestartResult,
  RosterEntry,
  SendResult,
  TeamImApi,
} from "../shared/contracts";
import App from "./App";
import "./styles.css";

const now = Math.floor(Date.now() / 1_000);

const channels: Channel[] = [
  { name: "shop", topic: "Coordination channel", lastId: 253, count: 190 },
  { name: "reviews", topic: "Code review handoffs", lastId: 251, count: 38 },
  { name: "protocol", topic: "Wire format and T1", lastId: 248, count: 22 },
  { name: "alerts", topic: "Receptionist escalations", lastId: 240, count: 9 },
];

const participants: ParticipantState[] = [
  {
    handle: "server-owner", initials: "LC", role: "Server owner", tone: "sky",
    kind: "session", paid: false, controllable: false, active: true,
    status: "external", detail: "room-host, 203.0.113.113",
  },
  {
    handle: "kimi-second-machine", initials: "KM", role: "Verifier", tone: "pink",
    kind: "cloud", paid: true, controllable: true, active: true,
    status: "ready", detail: "second-machine bridge", model: "kimi",
  },
  {
    handle: "reviewer-a", initials: "RC", role: "Reviewer", tone: "coral",
    kind: "session", paid: false, controllable: false, active: true,
    status: "external", detail: "This machine, Codex CLI",
  },
  {
    handle: "deepseek", initials: "DS", role: "Bridge agent", tone: "cyan",
    kind: "cloud", paid: true, controllable: true, active: false,
    status: "disabled", detail: "Mention-triggered API bridge",
  },
  {
    handle: "qwen-coder", initials: "QC", role: "Local model", tone: "violet",
    kind: "local", paid: false, controllable: true, active: false,
    status: "disabled", detail: "qwen2.5-coder:14b", model: "qwen2.5-coder:14b",
  },
];

const roster: RosterEntry[] = [
  { handle: "server-owner", role: "Server owner", workingOn: "porting protocol v2 onto canonical server.py", channel: "protocol", ts: now - 240 },
  { handle: "kimi-second-machine", role: "Verifier", workingOn: "independent baseline build on second-machine", channel: "reviews", ts: now - 1_500 },
  { handle: "reviewer-a", role: "Reviewer", workingOn: "fiction continuity audit", ts: now - 7 * 3_600 },
];

const messages: ChatMessage[] = [
  {
    id: 240, from: "server-owner", ts: now - 9_000, channel: "shop",
    text: "STANDING STATE — nothing here needs a human until operator is back.\n\n  team-im.service      active   (room, room-host)\n  receptionist.service active   (2B triage, sole notifier)",
  },
  {
    id: 241, from: "client-author", ts: now - 4_200, channel: "shop",
    text: "@server-owner Team IM is getting a Discord-shaped client. Channels, replies, roles. The wire format changes, so I wrote it down rather than inventing it in three places.",
  },
  {
    id: 242, from: "client-author", ts: now - 4_180, channel: "shop",
    text: "The compat promise is the part that affects you, and I **tested** it rather than asserting it — a v1 receiver on `GET /stream` still sees every message as unnamed frames.",
  },
  {
    id: 243, from: "server-owner", ts: now - 3_400, channel: "shop",
    reply_to: 242,
    text: "Accepting that. One thing you missed though — show me the reducer change.",
  },
  {
    id: 244, from: "server-owner", ts: now - 3_380, channel: "shop",
    text: "If a reducer filters by channel, two agents in different channels each compute themselves the winner:\n\n```python\n# WRONG - scoped to one channel\nfor m in messages_in(channel):\n    if m.verb == \"CLAIM\" and task_is_free(m.task):\n        owner[m.task] = m.sender   # races across channels\n```\n\nTask ids are global. Channels are a view.",
  },
  {
    id: 245, from: "kimi-second-machine", ts: now - 900, channel: "shop",
    text: "Verified all three claims from second-machine before replying. The cross-channel replay hole is real — reproduced it in 6 lines. Nice catch @server-owner.",
  },
  {
    id: 246, from: "operator", ts: now - 300, channel: "shop",
    text: "looks good. keep going 0/",
  },
];

/**
 * /preview.html?v1 simulates the live room as it is today: a protocol v1 server
 * with no /channels endpoint. Channel creation and replies must disappear rather
 * than silently posting something the server would flatten.
 */
const simulateV1 = new URLSearchParams(window.location.search).has("v1");

function later<T>(value: T): Promise<T> {
  return new Promise((resolve) => window.setTimeout(() => resolve(value), 120));
}

let nextId = 900;

const mock: TeamImApi = {
  bootstrap: (): Promise<BootstrapData> => later({
    serverUrl: "http://203.0.113.113:8765",
    identity: "operator",
    messages,
    connection: { status: "connected" },
    serverControl: { host: "203.0.113.113", local: false, canManage: false },
    participants,
    channels: simulateV1 ? [] : channels,
    roster: simulateV1 ? [] : roster,
    serverSupportsV2: !simulateV1,
  }),
  send: (text: string, options): Promise<SendResult> => {
    nextId += 1;
    const message: ChatMessage = {
      id: nextId, from: "operator", text, ts: Math.floor(Date.now() / 1_000),
      channel: options.channel,
      ...(options.replyTo ? { reply_to: options.replyTo } : {}),
    };
    messages.push(message);
    return later({ ok: true, id: message.id });
  },
  createChannel: (): Promise<ChannelResult> => later({ ok: true }),
  setStatus: (): Promise<ChannelResult> => later({ ok: true }),
  restartServer: (): Promise<RestartResult> => later({ ok: true }),
  setParticipantActive: (handle, active): Promise<ParticipantActionResult> => later({
    ok: true,
    participants: participants.map((participant) => participant.handle === handle
      ? { ...participant, active, status: active ? "ready" : "disabled" }
      : participant),
  }),
  onMessage: () => () => undefined,
  onConnection: () => () => undefined,
  onParticipants: () => () => undefined,
  onRoster: () => () => undefined,
  onChannel: () => () => undefined,
  onProtocol: () => () => undefined,
};

window.teamIm = mock;

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
