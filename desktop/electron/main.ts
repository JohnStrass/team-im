import fs from "node:fs";
import path from "node:path";

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  Tray
} from "electron";

import type {
  BootstrapData,
  Channel,
  ChannelResult,
  ChatMessage,
  ConnectionState,
  ParticipantActionResult,
  ParticipantState,
  RestartResult,
  RosterEntry,
  SendResult
} from "../shared/contracts";
import {
  DEFAULT_CHANNEL,
  normalizeChannelName,
  normalizeChannels,
  normalizeMessage,
  normalizeRoster,
  normalizeRosterEntry
} from "../shared/messages";
import { ParticipantController } from "./participant-control";
import {
  autoStartServer,
  resolveServerControl,
  restartLocalServer
} from "./server-control";

// The development runner provides this renderer URL; production ignores it.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const DEFAULT_SERVER_URL = "http://localhost:8765";
const DEFAULT_IDENTITY = "operator";
const HISTORY_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 12_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

const IPC_BOOTSTRAP = "team-im:bootstrap";
const IPC_SEND = "team-im:send";
const IPC_RESTART = "team-im:restart-server";
const IPC_PARTICIPANT_SET = "team-im:set-participant-active";
const IPC_MESSAGE = "team-im:message";
const IPC_CONNECTION = "team-im:connection";
const IPC_PARTICIPANTS = "team-im:participants";
const IPC_CHANNEL_CREATE = "team-im:create-channel";
const IPC_STATUS_SET = "team-im:set-status";
const IPC_ROSTER = "team-im:roster";
const IPC_CHANNEL = "team-im:channel";
const IPC_PROTOCOL = "team-im:protocol";

interface LocalConfig {
  serverUrl?: unknown;
  identity?: unknown;
  /** Optional explicit path to server.py for supervision. */
  serverScript?: unknown;
  /** Optional explicit path to python.exe (bare "python" can be the Store stub). */
  pythonPath?: unknown;
  /** Directory containing the private delegate.py and its credential routing. */
  delegateDir?: unknown;
  /** Optional explicit path to LM Studio's lms.exe. */
  lmsPath?: unknown;
}

function readLocalConfig(): LocalConfig {
  const configPath = app.isPackaged
    ? path.join(path.dirname(process.execPath), "team-im.local.json")
    : path.resolve(__dirname, "../../team-im.local.json");
  try {
    const value: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return value && typeof value === "object" ? (value as LocalConfig) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Ignoring unreadable local config at ${configPath}.`, error);
    }
    return {};
  }
}

const localConfig = readLocalConfig();

function readServerUrl(): string {
  const configured =
    process.env.TEAM_IM_SERVER?.trim() ||
    (typeof localConfig.serverUrl === "string" ? localConfig.serverUrl.trim() : "") ||
    DEFAULT_SERVER_URL;

  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("TEAM_IM_SERVER must use http or https");
    }
    return configured.replace(/\/+$/, "");
  } catch (error) {
    console.error(`Invalid TEAM_IM_SERVER; using ${DEFAULT_SERVER_URL}.`, error);
    return DEFAULT_SERVER_URL;
  }
}

function readIdentity(): string {
  const configured =
    process.env.TEAM_IM_IDENTITY?.trim() ||
    (typeof localConfig.identity === "string" ? localConfig.identity.trim() : "") ||
    DEFAULT_IDENTITY;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(configured)
    ? configured
    : DEFAULT_IDENTITY;
}

const serverUrl = readServerUrl();
const identity = readIdentity();

// server.py sits one level above the desktop project. That is three levels up
// from both the built main bundle (desktop/.vite/build) and the packaged exe
// (desktop/out/team-im-win32-x64); a copy right next to the exe also counts.
const supervisionBase = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const serverControl = resolveServerControl({
  serverUrl,
  scriptCandidates: [
    typeof localConfig.serverScript === "string" ? localConfig.serverScript.trim() : "",
    path.join(supervisionBase, "server.py"),
    path.resolve(supervisionBase, "../../../server.py")
  ].filter(Boolean),
  configuredPython:
    typeof localConfig.pythonPath === "string" && localConfig.pythonPath.trim()
      ? localConfig.pythonPath.trim()
      : undefined
});

function firstExistingPath(candidates: readonly string[], kind: "file" | "directory"): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = fs.statSync(candidate);
      if ((kind === "file" && stat.isFile()) || (kind === "directory" && stat.isDirectory())) {
        return candidate;
      }
    } catch {
      // Try the next local-only candidate.
    }
  }
  return null;
}

const teamRoot = serverControl.script
  ? path.dirname(serverControl.script)
  : path.resolve(supervisionBase, "../../..");
const bridgeScript = firstExistingPath([
  path.join(supervisionBase, "bridge.py"),
  path.join(teamRoot, "bridge.py")
], "file");
const delegateDir = firstExistingPath([
  typeof localConfig.delegateDir === "string" ? localConfig.delegateDir.trim() : "",
  path.resolve(teamRoot, "../local-agents")
], "directory");
const lmsPath = firstExistingPath([
  typeof localConfig.lmsPath === "string" ? localConfig.lmsPath.trim() : "",
  process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".lmstudio", "bin", "lms.exe")
    : ""
], "file");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let streamAbortController: AbortController | null = null;

let connection: ConnectionState = { status: "connecting" };
let messages: ChatMessage[] = [];
const seenMessageIds = new Set<number>();

/** Protocol v2 state. Empty and false until the startup probe says otherwise. */
let channels: Channel[] = [];
let roster: RosterEntry[] = [];
let serverSupportsV2 = false;

/**
 * Ask the server whether it speaks protocol v2 and load what it knows.
 *
 * A v1 server answers /channels with 404, which fetchJson turns into a throw.
 * That is the whole detection: no version header, no negotiation, just a probe
 * for the endpoint the new UI actually needs. Re-run on every reconnect so the
 * app picks up a server upgraded underneath it without a relaunch.
 */
async function refreshProtocolState(): Promise<void> {
  try {
    channels = normalizeChannels(await fetchJson<unknown>("/channels"));
    serverSupportsV2 = channels.length > 0;
  } catch {
    channels = [];
    serverSupportsV2 = false;
  }

  if (serverSupportsV2) {
    try {
      roster = normalizeRoster(await fetchJson<unknown>("/roster"));
    } catch {
      roster = [];
    }
  } else {
    roster = [];
  }

  // Publish the whole capability picture as ONE atomic snapshot after every
  // probe. Without this the renderer reads supportsV2 exactly once at bootstrap
  // and never hears about an upgrade or downgrade: after an upgrade the reply
  // and create-channel controls stay hidden until relaunch, and after a
  // downgrade they stay visible and fail only when used. (reviewer-a, P2)
  sendToRenderer(IPC_PROTOCOL, {
    serverSupportsV2,
    channels: [...channels],
    roster: [...roster],
  });
}

function acceptRosterEntry(value: unknown): void {
  const entry = normalizeRosterEntry(value);
  if (!entry) return;
  roster = [...roster.filter((row) => row.handle !== entry.handle), entry];
  sendToRenderer(IPC_ROSTER, entry);
}

function acceptChannel(value: unknown): void {
  const [channel] = normalizeChannels([value]);
  if (!channel) return;
  if (!channels.some((row) => row.name === channel.name)) {
    channels = [...channels, channel].sort((a, b) => a.name.localeCompare(b.name));
  }
  sendToRenderer(IPC_CHANNEL, channel);
}
let lastMessageId = 0;

let clientStarted = false;
let initialHistorySettled = false;
let resolveInitialHistory: (() => void) | null = null;
const initialHistoryReady = new Promise<void>((resolve) => {
  resolveInitialHistory = resolve;
});

const participantController = new ParticipantController({
  serverUrl,
  bridgeScript,
  delegateDir,
  python: serverControl.python,
  lmsPath
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settleInitialHistory(): void {
  if (initialHistorySettled) return;
  initialHistorySettled = true;
  resolveInitialHistory?.();
  resolveInitialHistory = null;
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

participantController.subscribe((participants: ParticipantState[]) => {
  sendToRenderer(IPC_PARTICIPANTS, participants);
});

function setConnection(next: ConnectionState): void {
  if (
    connection.status === next.status &&
    connection.detail === next.detail &&
    connection.attempt === next.attempt
  ) {
    return;
  }

  connection = next;
  sendToRenderer(IPC_CONNECTION, connection);
}

async function showMainWindow(): Promise<void> {
  await app.whenReady();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notifyMention(message: ChatMessage): void {
  // The portable build has no Start Menu shortcut or ToastActivator
  // registration, so Windows may discard its notifications. Keep them off
  // until an installer can register the matching AppUserModelID correctly.
  if (
    app.isPackaged ||
    message.from.toLowerCase() === identity.toLowerCase() ||
    !new RegExp(`@${identity}\\b`, "i").test(message.text) ||
    !Notification.isSupported()
  ) {
    return;
  }

  const notification = new Notification({
    title: `${message.from} mentioned you`,
    body: message.text,
    silent: false
  });
  notification.on("click", showMainWindow);
  notification.show();
}

function acceptMessage(
  message: ChatMessage,
  options: { broadcast: boolean; notify: boolean }
): void {
  // The stream and catch-up request can overlap. IDs make that overlap safe.
  if (seenMessageIds.has(message.id) || message.id <= lastMessageId - HISTORY_LIMIT) return;

  seenMessageIds.add(message.id);
  lastMessageId = Math.max(lastMessageId, message.id);
  messages.push(message);
  messages.sort((left, right) => left.id - right.id);

  if (messages.length > HISTORY_LIMIT) {
    const discarded = messages.splice(0, messages.length - HISTORY_LIMIT);
    for (const oldMessage of discarded) seenMessageIds.delete(oldMessage.id);
  }

  if (options.broadcast) sendToRenderer(IPC_MESSAGE, message);
  if (options.notify) notifyMention(message);
}

async function fetchJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${serverUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function catchUp(broadcast: boolean): Promise<void> {
  const pathname = lastMessageId > 0 ? `/messages?since_id=${lastMessageId}` : "/messages";
  const payload = await fetchJson<unknown>(pathname);
  if (!Array.isArray(payload)) throw new Error("Server returned invalid message history");

  for (const value of payload) {
    const message = normalizeMessage(value);
    if (!message) continue;
    acceptMessage(message, { broadcast, notify: broadcast });
  }
}

function parseSseFrame(frame: string): void {
  const lines = frame.split(/\r?\n/);

  // Protocol v2 sends roster and channel updates as NAMED events, and messages
  // as unnamed ones. Reading the event field is what keeps a roster frame from
  // being mistaken for a chat message.
  const eventName =
    lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim() ?? "message";

  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");

  if (!data) return; // Keepalive comments contain no data field.

  try {
    const value: unknown = JSON.parse(data);
    if (eventName === "roster") {
      acceptRosterEntry(value);
      return;
    }
    if (eventName === "channel") {
      acceptChannel(value);
      return;
    }
    const message = normalizeMessage(value);
    if (message) acceptMessage(message, { broadcast: true, notify: true });
  } catch (error) {
    console.warn("Ignoring malformed team-im stream event.", error);
  }
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Live stream stopped responding")),
      70_000
    );
    void reader.read().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function consumeStream(onHealthy: () => void): Promise<void> {
  const controller = new AbortController();
  streamAbortController = controller;

  try {
    const response = await fetch(`${serverUrl}/stream?live=1`, {
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Stream returned HTTP ${response.status}`);
    if (!response.body) throw new Error("Stream response had no body");

    setConnection({ status: "connected" });

    // Re-probe on every reconnect: the server may have been upgraded to v2
    // underneath a running app, and this is the cheapest place to notice.
    await refreshProtocolState();

    // Close the small race between the history request and stream registration.
    // Duplicate IDs are ignored by acceptMessage.
    await catchUp(true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const healthyTimer = setTimeout(onHealthy, 30_000);

    try {
      while (!quitting) {
        const { done, value } = await readStreamChunk(reader);
        if (done) break;
        onHealthy();
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
          buffer = buffer.slice(boundary + separator.length);
          parseSseFrame(frame);
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
    } finally {
      clearTimeout(healthyTimer);
    }

    if (!quitting) throw new Error("Live stream closed");
  } finally {
    if (streamAbortController === controller) streamAbortController = null;
    controller.abort();
  }
}

// A successful manual restart skips the remaining backoff wait so the app
// reconnects immediately instead of sitting out up to 30 seconds.
let wakeReconnect: (() => void) | null = null;
let reconnectAttempt = 0;

function reconnectDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      if (wakeReconnect === finish) wakeReconnect = null;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    wakeReconnect = finish;
  });
}

async function runChatClient(): Promise<void> {
  // If this machine should be hosting the server and it is not up yet,
  // launch it before the first connection attempt.
  if (serverControl.local) {
    try {
      const started = await autoStartServer(serverControl, (detail) =>
        setConnection({ status: "connecting", detail })
      );
      if (!started.ok && started.error) {
        setConnection({ status: "connecting", detail: started.error });
      }
    } catch (error) {
      setConnection({
        status: "connecting",
        detail: `Could not start the local server: ${errorText(error)}`
      });
    }
  }

  let firstAttempt = true;

  while (!quitting) {
    setConnection({
      status: firstAttempt ? "connecting" : "reconnecting",
      ...(firstAttempt ? {} : { attempt: reconnectAttempt })
    });

    try {
      await catchUp(initialHistorySettled);
      settleInitialHistory();
      firstAttempt = false;
      await consumeStream(() => {
        reconnectAttempt = 0;
      });
    } catch (error) {
      if (quitting) break;

      settleInitialHistory();
      reconnectAttempt += 1;
      const waitMs =
        RECONNECT_DELAYS_MS[Math.min(reconnectAttempt - 1, RECONNECT_DELAYS_MS.length - 1)];
      setConnection({
        status: firstAttempt ? "offline" : "reconnecting",
        detail: `${errorText(error)}. Check that server.py is running; retrying in ${Math.round(waitMs / 1000)}s.`,
        attempt: reconnectAttempt
      });
      firstAttempt = false;
      await reconnectDelay(waitMs);
    }
  }
}

function ensureChatClientStarted(): void {
  if (clientStarted) return;
  clientStarted = true;
  void runChatClient();
}

async function sendMessage(textValue: unknown, options: unknown): Promise<SendResult> {
  if (typeof textValue !== "string") return { ok: false, error: "Message must be text." };
  const text = textValue.trim();
  if (!text) return { ok: false, error: "Message cannot be empty." };
  if ([...text].length > 8_000) {
    return { ok: false, error: "Message is longer than 8,000 characters." };
  }

  // The renderer is untrusted from this process's point of view, so the channel
  // and parent id are re-validated here rather than forwarded as given.
  const opts = (options ?? {}) as Record<string, unknown>;
  const channel = normalizeChannelName(opts.channel) ?? DEFAULT_CHANNEL;
  const replyTo =
    Number.isSafeInteger(opts.replyTo) && (opts.replyTo as number) > 0
      ? (opts.replyTo as number)
      : undefined;

  // An explicitly invalid channel is refused, not coerced. Coercing would file
  // a real message under a channel nobody asked for. (reviewer-a, P2)
  if (opts.channel !== undefined && normalizeChannelName(opts.channel) === null) {
    return { ok: false, error: "That channel name is not valid." };
  }
  if (opts.replyTo !== undefined && replyTo === undefined) {
    return { ok: false, error: "That reply target is not a valid message id." };
  }

  // Against a v1 server these fields are ignored, which would silently flatten
  // a reply into an ordinary message. Refuse instead of lying to the operator.
  //
  // A CACHED capability is not good enough for this. reviewer-a traced the hole:
  // if the v2 server dies and a v1 server binds the same address during the
  // reconnect/backoff window, serverSupportsV2 is still a stale `true`, the
  // send succeeds, and v1 drops reply_to on the floor. So a reply RE-PROBES at
  // send time and fails closed - the cheap GET is worth it on the rare path
  // where the operator is deliberately answering a specific message.
  if (replyTo !== undefined) {
    await refreshProtocolState();
    if (!serverSupportsV2) {
      return {
        ok: false,
        error: "The server no longer supports replies (protocol v1). Your text was not sent.",
      };
    }
  }

  if (!serverSupportsV2 && replyTo !== undefined) {
    return { ok: false, error: "This server does not support replies yet (protocol v1)." };
  }

  const payload: Record<string, unknown> = { from: identity, text };
  if (serverSupportsV2) {
    payload.channel = channel;
    if (replyTo !== undefined) payload.reply_to = replyTo;
  }

  try {
    const response = await fetchJson<unknown>("/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response || typeof response !== "object") {
      return { ok: false, error: "Server returned an invalid response." };
    }
    const data = response as Record<string, unknown>;
    return data.ok === true && typeof data.id === "number" && Number.isInteger(data.id)
      ? { ok: true, id: data.id }
      : { ok: false, error: typeof data.error === "string" ? data.error : "Message was not accepted." };
  } catch (error) {
    return { ok: false, error: `Unable to send: ${errorText(error)}` };
  }
}

async function createChannel(nameValue: unknown, topicValue: unknown): Promise<ChannelResult> {
  if (!serverSupportsV2) {
    return { ok: false, error: "This server does not support channels yet (protocol v1)." };
  }
  const name = normalizeChannelName(nameValue);
  if (!name) {
    return { ok: false, error: "Channel names use lower-case letters, numbers and dashes." };
  }
  const topic = typeof topicValue === "string" ? topicValue.trim().slice(0, 200) : "";

  try {
    await fetchJson<unknown>("/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, topic })
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Unable to create the channel: ${errorText(error)}` };
  }
}

/** Announce this instance's lane so other machines can see who is doing what. */
async function setStatus(
  roleValue: unknown,
  workingOnValue: unknown,
  channelValue: unknown
): Promise<ChannelResult> {
  if (!serverSupportsV2) {
    return { ok: false, error: "This server does not support the roster yet (protocol v1)." };
  }
  const role = typeof roleValue === "string" ? roleValue.trim().slice(0, 40) : "";
  const workingOn = typeof workingOnValue === "string" ? workingOnValue.trim().slice(0, 120) : "";
  const channel = normalizeChannelName(channelValue);

  try {
    await fetchJson<unknown>("/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: identity,
        role,
        working_on: workingOn,
        ...(channel ? { channel } : {})
      })
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Unable to update your status: ${errorText(error)}` };
  }
}

let restartInFlight = false;

async function handleRestartRequest(): Promise<RestartResult> {
  if (restartInFlight) return { ok: false, error: "A restart is already in progress." };
  restartInFlight = true;
  try {
    const result = await restartLocalServer(serverControl, (detail) =>
      setConnection({ status: "reconnecting", detail })
    );
    if (result.ok) {
      // Drop the current (dead) stream and skip any backoff wait; the client
      // loop then reconnects to the fresh server within about a second.
      reconnectAttempt = 0;
      streamAbortController?.abort();
      wakeReconnect?.();
    } else {
      setConnection({
        status: "offline",
        detail: result.error ?? "The server restart failed."
      });
    }
    return result;
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    restartInFlight = false;
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC_BOOTSTRAP, async (): Promise<BootstrapData> => {
    ensureChatClientStarted();
    await initialHistoryReady;
    return {
      serverUrl,
      identity,
      messages: [...messages],
      connection: { ...connection },
      serverControl: {
        host: serverControl.host,
        local: serverControl.local,
        canManage: serverControl.canManage
      },
      participants: participantController.snapshot(),
      channels: [...channels],
      roster: [...roster],
      serverSupportsV2
    };
  });

  ipcMain.handle(
    IPC_SEND,
    (_event, text: unknown, options: unknown): Promise<SendResult> => sendMessage(text, options)
  );

  ipcMain.handle(
    IPC_CHANNEL_CREATE,
    (_event, name: unknown, topic: unknown): Promise<ChannelResult> => createChannel(name, topic)
  );

  ipcMain.handle(
    IPC_STATUS_SET,
    (_event, role: unknown, workingOn: unknown, channel: unknown): Promise<ChannelResult> =>
      setStatus(role, workingOn, channel)
  );

  ipcMain.handle(IPC_RESTART, (): Promise<RestartResult> => handleRestartRequest());

  ipcMain.handle(
    IPC_PARTICIPANT_SET,
    (_event, handle: unknown, active: unknown): Promise<ParticipantActionResult> =>
      participantController.setActive(handle, active)
  );
}

/**
 * Measure what the operator would actually see, in the packaged window.
 *
 * Deliberately checks VISIBILITY (rect against the viewport) rather than
 * presence in the DOM, because presence is what passed while the composer sat
 * at 0px height off the bottom edge.
 */
async function runSelfCheck(): Promise<void> {
  const script = `(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { present: false };
      const b = el.getBoundingClientRect();
      return {
        present: true,
        top: Math.round(b.top),
        height: Math.round(b.height),
        visible: b.height > 0 && b.width > 0 && b.top < innerHeight && b.bottom > 0,
        clippedTop: b.top < 0
      };
    };
    return {
      viewport: innerWidth + "x" + innerHeight,
      composer: rect(".composer"),
      composerInput: rect(".composer-input textarea"),
      sendButton: rect(".send-button"),
      channelRail: rect(".channel-rail"),
      railHeader: rect(".rail-header"),
      channelHeader: rect(".channel-header"),
      memberRail: rect(".member-rail"),
      timeline: rect(".timeline"),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      messages: document.querySelectorAll(".message").length,
      liveLocalModels: [...document.querySelectorAll(".member-card")]
        .filter((c) => c.dataset.status === "ready")
        .map((c) => c.querySelector("strong")?.textContent)
    };
  })()`;

  let failures: string[] = [];
  try {
    const result = await mainWindow!.webContents.executeJavaScript(script, true) as Record<string, {
      present?: boolean; visible?: boolean; clippedTop?: boolean; height?: number;
    }> & { horizontalOverflow?: boolean };

    console.log("SELF-CHECK " + JSON.stringify(result, null, 1));

    // The operator must be able to type. This is the check that was missing.
    for (const key of ["composer", "composerInput", "sendButton", "channelRail", "channelHeader", "timeline"]) {
      const entry = result[key];
      if (!entry?.present) failures.push(`${key} is absent`);
      else if (!entry.visible) failures.push(`${key} is present but NOT VISIBLE`);
      else if (entry.clippedTop) failures.push(`${key} is clipped above the viewport`);
    }
    if (result.horizontalOverflow) failures.push("the page overflows horizontally");
  } catch (error) {
    failures.push(`self-check could not run: ${errorText(error)}`);
  }

  if (failures.length > 0) {
    console.error(["SELF-CHECK FAILED:", ...failures].join("\n  "));
    quitting = true;
    app.exit(1);
    return;
  }
  console.log("SELF-CHECK PASSED");
  quitting = true;
  app.exit(0);
}

function createTrayIcon() {
  // A tiny coral status dot avoids depending on a renderer or unpacked image.
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 6.5 ** 2;
      if (!inside) continue;
      bitmap[offset] = 0x8a; // Blue, green, red, alpha (Windows BGRA bitmap)
      bitmap[offset + 1] = 0x9d;
      bitmap[offset + 2] = 0xff;
      bitmap[offset + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 1 });
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip("team-im");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show team-im", click: showMainWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("double-click", showMainWindow);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 780,
    minHeight: 560,
    show: false,
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      devTools: !app.isPackaged
    }
  });

  // Remove the application menu entirely rather than only auto-hiding it.
  // autoHideMenuBar hides the menu VISUALLY but Windows still reserves its
  // strip in the layout, which pushed the whole three-column shell up and cut
  // the top off every rail - the channel header, the CHANNELS label and the
  // first roster row all lost their top edge. Reported by operator from a running
  // build; it does not reproduce in a browser at the same viewport, because a
  // browser has no menu bar to reserve.
  mainWindow.removeMenu();

  // --self-check: measure the REAL packaged renderer and exit non-zero if the
  // operator would not be able to use it. This exists because three UI bugs
  // reached the operator that every test and the browser preview passed: the
  // menu bar reserving space, the composer collapsing to 0px, and prompt()
  // throwing. None were visible anywhere except the packaged app, and
  // "the element exists" is a different claim from "the operator can see it".
  if (process.argv.includes("--self-check")) {
    mainWindow.once("ready-to-show", () => {
      setTimeout(() => void runSelfCheck(), 3_500);
    });
    mainWindow.show();
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // The renderer is local application code, never a general-purpose browser.
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const envDevUrl = process.env.VITE_DEV_SERVER_URL?.trim();
  const forgeDevUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined"
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : undefined;
  const devUrl = envDevUrl || forgeDevUrl;

  if (!app.isPackaged && devUrl) {
    const parsed = new URL(devUrl);
    const isExpectedDevOrigin =
      parsed.protocol === "http:" &&
      parsed.hostname === "localhost" &&
      parsed.port === "5173";
    if (!isExpectedDevOrigin) throw new Error("Refusing unexpected renderer development URL");
    void mainWindow.loadURL(parsed.origin);
  } else {
    const rendererName =
      typeof MAIN_WINDOW_VITE_NAME !== "undefined" ? MAIN_WINDOW_VITE_NAME : "main_window";
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${rendererName}/index.html`));
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let shutdownStarted = false;
let shutdownComplete = false;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.setAppUserModelId("com.teamim.desktop");
  registerIpc();

  app.on("second-instance", () => void showMainWindow());
  app.on("before-quit", (event) => {
    quitting = true;
    streamAbortController?.abort();
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void participantController.shutdown().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
  app.on("activate", () => void showMainWindow());

  void app.whenReady().then(() => {
    // The client has no reason to request camera, microphone, location, USB,
    // notifications through Chromium, or any other renderer permission.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    createMainWindow();
    createTray();
    ensureChatClientStarted();
  });
}
