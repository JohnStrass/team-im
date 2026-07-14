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
  ChatMessage,
  ConnectionState,
  SendResult
} from "../shared/contracts";
import { normalizeMessage } from "../shared/messages";

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
const IPC_MESSAGE = "team-im:message";
const IPC_CONNECTION = "team-im:connection";

interface LocalConfig {
  serverUrl?: unknown;
  identity?: unknown;
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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let streamAbortController: AbortController | null = null;

let connection: ConnectionState = { status: "connecting" };
let messages: ChatMessage[] = [];
const seenMessageIds = new Set<number>();
let lastMessageId = 0;

let clientStarted = false;
let initialHistorySettled = false;
let resolveInitialHistory: (() => void) | null = null;
const initialHistoryReady = new Promise<void>((resolve) => {
  resolveInitialHistory = resolve;
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
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");

  if (!data) return; // Keepalive comments contain no data field.

  try {
    const value: unknown = JSON.parse(data);
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runChatClient(): Promise<void> {
  let attempt = 0;
  let firstAttempt = true;

  while (!quitting) {
    setConnection({
      status: firstAttempt ? "connecting" : "reconnecting",
      ...(firstAttempt ? {} : { attempt })
    });

    try {
      await catchUp(initialHistorySettled);
      settleInitialHistory();
      firstAttempt = false;
      await consumeStream(() => {
        attempt = 0;
      });
    } catch (error) {
      if (quitting) break;

      settleInitialHistory();
      attempt += 1;
      const waitMs = RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)];
      setConnection({
        status: firstAttempt ? "offline" : "reconnecting",
        detail: `${errorText(error)}. Check that server.py is running; retrying in ${Math.round(waitMs / 1000)}s.`,
        attempt
      });
      firstAttempt = false;
      await delay(waitMs);
    }
  }
}

function ensureChatClientStarted(): void {
  if (clientStarted) return;
  clientStarted = true;
  void runChatClient();
}

async function sendMessage(textValue: unknown): Promise<SendResult> {
  if (typeof textValue !== "string") return { ok: false, error: "Message must be text." };
  const text = textValue.trim();
  if (!text) return { ok: false, error: "Message cannot be empty." };
  if ([...text].length > 8_000) {
    return { ok: false, error: "Message is longer than 8,000 characters." };
  }

  try {
    const response = await fetchJson<unknown>("/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: identity, text })
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

function registerIpc(): void {
  ipcMain.handle(IPC_BOOTSTRAP, async (): Promise<BootstrapData> => {
    ensureChatClientStarted();
    await initialHistoryReady;
    return {
      serverUrl,
      identity,
      messages: [...messages],
      connection: { ...connection }
    };
  });

  ipcMain.handle(IPC_SEND, (_event, text: unknown): Promise<SendResult> => sendMessage(text));
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

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.setAppUserModelId("com.teamim.desktop");
  registerIpc();

  app.on("second-instance", () => void showMainWindow());
  app.on("before-quit", () => {
    quitting = true;
    streamAbortController?.abort();
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
