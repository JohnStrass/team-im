/**
 * Explicit participant lifecycle control.
 *
 * Opening Team IM starts only the tiny chat server. Cloud bridges and local
 * models stay off until the operator enables them from the participant panel.
 * This module deliberately has no Electron dependency so its decisions remain
 * testable without launching a desktop window.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ParticipantActionResult,
  ParticipantKind,
  ParticipantState
} from "../shared/contracts";
import type { PythonCommand } from "./server-control";

const execFileAsync = promisify(execFile);
const BRIDGE_START_GRACE_MS = 900;
const PROCESS_TIMEOUT_MS = 180_000;

export interface ParticipantDefinition {
  handle: string;
  initials: string;
  role: string;
  tone: string;
  kind: ParticipantKind;
  paid: boolean;
  model?: string;
  worker?: string;
  modelKey?: string;
  modelIdentifier?: string;
  /** Which local runtime hosts it. Defaults to LM Studio. */
  backend?: "lmstudio" | "ollama";
}

export interface ParticipantControlConfig {
  serverUrl: string;
  bridgeScript: string | null;
  delegateDir: string | null;
  python: PythonCommand | null;
  lmsPath: string | null;
}

const DEFINITIONS: readonly ParticipantDefinition[] = Object.freeze([
  {
    handle: "client-author",
    initials: "RC",
    role: "Main-rig Claude session",
    tone: "mint",
    kind: "session",
    paid: false
  },
  {
    handle: "server-owner",
    initials: "LC",
    role: "Remote Claude session",
    tone: "sky",
    kind: "session",
    paid: false
  },
  {
    handle: "codex",
    initials: "CX",
    role: "Codex session",
    tone: "coral",
    kind: "session",
    paid: false
  },
  {
    handle: "claude-api",
    initials: "CA",
    role: "Claude API",
    tone: "mint",
    kind: "cloud",
    paid: true,
    model: "Claude Sonnet",
    worker: "sonnet"
  },
  {
    handle: "deepseek",
    initials: "DS",
    role: "DeepSeek API",
    tone: "cyan",
    kind: "cloud",
    paid: true,
    model: "DeepSeek Chat",
    worker: "deepseek"
  },
  {
    handle: "kimi",
    initials: "KM",
    role: "Kimi API",
    tone: "pink",
    kind: "cloud",
    paid: true,
    model: "Kimi K2.6",
    worker: "kimi"
  },
  {
    handle: "atlas",
    initials: "AT",
    role: "Local thinking partner",
    tone: "violet",
    kind: "local",
    paid: false,
    model: "Mixed V1 Q6K",
    worker: "helper",
    modelKey: "gemma-4-local-model_-12b-it@q6_k",
    modelIdentifier: "gemma-4-local-model_-12b-it@q6_k"
  },
  {
    handle: "scout",
    initials: "SC",
    role: "Fast local generalist",
    tone: "mint",
    kind: "local",
    paid: false,
    model: "Gemma 4 E4B Q6K",
    worker: "scout",
    modelKey: "gemma-4-e4b-it-q6k",
    modelIdentifier: "gemma-4-e4b-it-q6k"
  },
  {
    handle: "gemma-coder",
    initials: "GC",
    role: "Local coding model",
    tone: "amber",
    kind: "local",
    paid: false,
    model: "Gemma Code V2 Q6K",
    worker: "gemma",
    modelKey: "gemma4-code-v2",
    modelIdentifier: "gemma4-code-v2"
  },
  {
    // Detect-only: Ollama hosts this one, and Team IM does not load or unload
    // it. Showing it when it is genuinely running is the point - the operator
    // asked to SEE which local models are live and be able to mention them.
    handle: "qwen-coder",
    initials: "QC",
    role: "Local coding model",
    tone: "cyan",
    kind: "local",
    paid: false,
    model: "qwen2.5-coder:14b",
    worker: "qwen",
    modelKey: "qwen2.5-coder:14b",
    modelIdentifier: "qwen2.5-coder:14b",
    backend: "ollama"
  },
  {
    // An agent process, not a model this app hosts - so no modelIdentifier and
    // no load/unload. It runs its own tool loop and answers from research, which
    // makes it slower than the chat models and worth mentioning deliberately
    // rather than sweeping into @everyone (the bridge enforces that exclusion).
    handle: "hermes",
    initials: "HM",
    role: "Local research agent",
    tone: "sky",
    kind: "agent",
    paid: false,
    model: "Hermes Agent",
    worker: "hermes"
  }
]);

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    const withStderr = error as Error & { stderr?: string | Buffer };
    const stderr = typeof withStderr.stderr === "string"
      ? withStderr.stderr
      : Buffer.isBuffer(withStderr.stderr)
        ? withStderr.stderr.toString("utf8")
        : "";
    return (stderr.trim() || error.message).slice(0, 500);
  }
  return String(error).slice(0, 500);
}

export function isLoadedModel(payload: unknown, identifiers: readonly string[]): boolean {
  if (!Array.isArray(payload)) return false;
  const wanted = new Set(identifiers.map((value) => value.trim().toLowerCase()).filter(Boolean));
  return payload.some((row) => {
    if (!row || typeof row !== "object") return false;
    const values = Object.values(row as Record<string, unknown>)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase());
    return values.some((value) => wanted.has(value));
  });
}

export function baseParticipantState(
  definition: ParticipantDefinition,
  config: ParticipantControlConfig
): ParticipantState {
  if (definition.kind === "session") {
    return {
      ...definition,
      controllable: false,
      active: false,
      status: "external",
      detail: "External session. Mention it when that agent is connected to Team IM."
    };
  }

  const bridgeReady = Boolean(
    config.bridgeScript && config.delegateDir && config.python
  );
  // Phrased as "local needs the lms CLI" rather than "cloud needs only the
  // bridge". Same truth today, but a kind added later lands in the simpler,
  // safer branch instead of silently demanding a CLI it never uses - which is
  // exactly what the previous phrasing did to "agent".
  const controllable = definition.kind === "local"
    ? bridgeReady && Boolean(config.lmsPath)
    : bridgeReady;

  if (!controllable) {
    return {
      ...definition,
      controllable: false,
      active: false,
      status: "unavailable",
      detail: definition.kind === "local"
        ? "Configure bridge.py, delegateDir, Python, and lmsPath in team-im.local.json."
        : "Configure bridge.py, delegateDir, and Python in team-im.local.json."
    };
  }

  return {
    ...definition,
    controllable: true,
    active: false,
    status: "disabled",
    detail: definition.kind === "local"
      ? "Not loaded. Uses 0 VRAM."
      : "Disabled. Enabling makes no API call; replies remain mention-only."
  };
}

export function participantDefinitions(): readonly ParticipantDefinition[] {
  return DEFINITIONS;
}

export class ParticipantController {
  private readonly states = new Map<string, ParticipantState>();
  private readonly listeners = new Set<(states: ParticipantState[]) => void>();
  private readonly ownedLocalModels = new Set<string>();
  private readonly intentionalBridgeStops = new Set<ChildProcess>();
  private bridge: ChildProcess | null = null;
  private changing = Promise.resolve();

  /** Handle for the detection poll, so it can be stopped on shutdown. */
  private detectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ParticipantControlConfig) {
    for (const definition of DEFINITIONS) {
      this.states.set(definition.handle, baseParticipantState(definition, config));
    }

    // Poll the local runtimes so a model the operator loads or unloads by hand
    // shows up without relaunching the app. Read-only and cheap: two localhost
    // requests with a short timeout, and both failing is the ordinary case when
    // nothing is running.
    void this.detectLoadedModels();
    this.detectTimer = setInterval(() => void this.detectLoadedModels(), 15_000);
    this.detectTimer.unref?.();
  }

  /** Stop the detection poll. */
  stopDetecting(): void {
    if (this.detectTimer) {
      clearInterval(this.detectTimer);
      this.detectTimer = null;
    }
  }

  snapshot(): ParticipantState[] {
    return DEFINITIONS.map((definition) => ({ ...this.states.get(definition.handle)! }));
  }

  subscribe(listener: (states: ParticipantState[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const states = this.snapshot();
    for (const listener of this.listeners) listener(states);
  }

  /**
   * Ask the local runtimes which models are ACTUALLY loaded right now.
   *
   * Previously a local model only ever showed "ready" if Team IM had loaded it
   * itself, so a model the operator loaded by hand in LM Studio - the normal
   * case - sat there reading "0 VRAM / Load" while it was running and serving
   * requests. The app was reporting its own bookkeeping as though it were the
   * state of the machine.
   *
   * Detection is read-only and never claims ownership: resourceOwned stays
   * false for anything we did not load, so the UI offers Disconnect rather than
   * Unload and we never tear down a model the operator is using elsewhere.
   */
  private async detectLoadedModels(): Promise<void> {
    const loaded = new Set<string>();

    // LM Studio: /api/v0/models reports a per-model state.
    try {
      const response = await fetch("http://127.0.0.1:1234/api/v0/models", {
        signal: AbortSignal.timeout(2_500)
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: { id?: string; state?: string }[] };
        for (const model of body.data ?? []) {
          if (model.id && model.state === "loaded") loaded.add(model.id.toLowerCase());
        }
      }
    } catch {
      // Runtime not running is a normal state, not an error worth surfacing.
    }

    // Ollama: /api/ps lists models resident in memory right now.
    try {
      const response = await fetch("http://127.0.0.1:11434/api/ps", {
        signal: AbortSignal.timeout(2_500)
      });
      if (response.ok) {
        const body = (await response.json()) as { models?: { name?: string; model?: string }[] };
        for (const model of body.models ?? []) {
          const name = model.name ?? model.model;
          if (name) loaded.add(name.toLowerCase());
        }
      }
    } catch {
      // Same.
    }

    for (const definition of DEFINITIONS) {
      if (definition.kind !== "local" || !definition.modelIdentifier) continue;
      const state = this.states.get(definition.handle);
      if (!state) continue;
      // Never fight an action in flight, and never downgrade what we own.
      if (state.status === "enabling" || state.status === "disabling") continue;
      if (state.resourceOwned) continue;

      const isLive = loaded.has(definition.modelIdentifier.toLowerCase())
        || (definition.modelKey ? loaded.has(definition.modelKey.toLowerCase()) : false);
      if (isLive === Boolean(state.modelLoaded)) continue;

      const runtime = definition.backend === "ollama" ? "Ollama" : "LM Studio";
      // Report ONLY that the model is resident. Do not touch status or active:
      // being loaded does not make a participant able to answer a mention, and
      // saying otherwise is the misleading part. Connecting it to the room is
      // still an explicit operator action, which is also what keeps the token
      // and VRAM guardrail honest.
      this.update(definition.handle, {
        modelLoaded: isLive,
        detail: isLive && state.status !== "ready"
          ? `Loaded in ${runtime}, but not connected to the room. Enable it to answer mentions.`
          : isLive
            ? `Loaded in ${runtime}.`
            : `Not loaded in ${runtime}.`
      });
    }
  }

  private update(handle: string, patch: Partial<ParticipantState>): void {
    const current = this.states.get(handle);
    if (!current) return;
    this.states.set(handle, { ...current, ...patch });
    this.emit();
  }

  setActive(handleValue: unknown, activeValue: unknown): Promise<ParticipantActionResult> {
    const handle = typeof handleValue === "string" ? handleValue.trim().toLowerCase() : "";
    const active = activeValue === true;

    const operation = async (): Promise<ParticipantActionResult> => {
      const state = this.states.get(handle);
      if (!state) return { ok: false, participants: this.snapshot(), error: "Unknown participant." };
      if (!state.controllable || state.kind === "session") {
        return {
          ok: false,
          participants: this.snapshot(),
          error: `${state.handle} is controlled by an external agent session.`
        };
      }
      if (active === state.active && state.status === "ready") {
        return { ok: true, participants: this.snapshot() };
      }

      try {
        if (active) await this.enable(state);
        else await this.disable(state);
        return { ok: true, participants: this.snapshot() };
      } catch (error) {
        const detail = messageFromError(error);
        this.update(handle, { active: false, status: "error", detail });
        return { ok: false, participants: this.snapshot(), error: detail };
      }
    };

    const result = this.changing.then(operation, operation);
    this.changing = result.then(() => undefined, () => undefined);
    return result;
  }

  private async enable(state: ParticipantState): Promise<void> {
    this.update(state.handle, {
      active: false,
      status: "enabling",
      detail: state.kind === "local" ? "Loading model into LM Studio..." : "Enabling mention-only bridge..."
    });

    let resourceOwned = false;
    if (state.kind === "local") {
      const other = this.snapshot().find((candidate) =>
        candidate.kind === "local" && candidate.handle !== state.handle && candidate.active
      );
      if (other) throw new Error(`Unload ${other.model ?? other.handle} before loading another local model.`);
      resourceOwned = await this.ensureLocalModel(state.handle);
    }

    this.update(state.handle, {
      active: true,
      status: "ready",
      resourceOwned,
      detail: state.kind === "local"
        ? resourceOwned
          ? "Loaded by Team IM. Replies only when mentioned."
          : "Connected to a model already loaded in LM Studio. Replies only when mentioned."
        : "Enabled. No API call occurs until this participant is mentioned."
    });

    await this.restartBridge();
  }

  private async disable(state: ParticipantState): Promise<void> {
    this.update(state.handle, {
      status: "disabling",
      detail: state.kind === "local" ? "Disconnecting and releasing the model..." : "Disabling bridge..."
    });

    // Remove the participant before restarting so no new mention can enter it.
    this.update(state.handle, { active: false });
    await this.restartBridge();

    if (state.kind === "local" && this.ownedLocalModels.has(state.handle)) {
      const definition = DEFINITIONS.find((candidate) => candidate.handle === state.handle)!;
      await this.runLms(["unload", definition.modelIdentifier!], 60_000);
      this.ownedLocalModels.delete(state.handle);
    }

    this.update(state.handle, {
      active: false,
      status: "disabled",
      resourceOwned: false,
      detail: state.kind === "local"
        ? "Not loaded. Uses 0 VRAM."
        : "Disabled. Enabling makes no API call; replies remain mention-only."
    });
  }

  private async ensureLocalModel(handle: string): Promise<boolean> {
    const definition = DEFINITIONS.find((candidate) => candidate.handle === handle);
    if (!definition?.modelKey || !definition.modelIdentifier) throw new Error("Local model is not configured.");

    const ps = await this.runLmsJson(["ps", "--json"]);
    if (isLoadedModel(ps, [definition.modelKey, definition.modelIdentifier])) {
      return this.ownedLocalModels.has(handle);
    }

    const anyLoaded = Array.isArray(ps) && ps.length > 0;
    if (anyLoaded) {
      throw new Error("Another LM Studio model is already loaded. Unload it before Team IM claims VRAM.");
    }

    const status = await this.runLmsJson(["server", "status", "--json"], true);
    const running = Boolean(status && typeof status === "object" && (status as { running?: unknown }).running === true);
    if (!running) {
      await this.runLms(["server", "start", "--port", "1234", "--bind", "127.0.0.1"], 30_000);
    }

    await this.runLms([
      "load",
      definition.modelKey,
      "--identifier",
      definition.modelIdentifier,
      "--context-length",
      "32768",
      "--gpu",
      "max",
      "--yes"
    ]);
    this.ownedLocalModels.add(handle);
    return true;
  }

  private async runLms(args: string[], timeout = PROCESS_TIMEOUT_MS): Promise<string> {
    if (!this.config.lmsPath) throw new Error("LM Studio CLI is not configured.");
    const result = await execFileAsync(this.config.lmsPath, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout;
  }

  private async runLmsJson(args: string[], tolerateFailure = false): Promise<unknown> {
    try {
      const output = await this.runLms(args, 30_000);
      return JSON.parse(output || "null") as unknown;
    } catch (error) {
      if (tolerateFailure) return null;
      throw error;
    }
  }

  private enabledHandles(): string[] {
    return this.snapshot()
      .filter((state) => state.controllable && state.active && state.status === "ready")
      .map((state) => state.handle);
  }

  private stopBridge(): void {
    if (!this.bridge) return;
    const child = this.bridge;
    this.intentionalBridgeStops.add(child);
    child.kill();
    this.bridge = null;
  }

  private async restartBridge(): Promise<void> {
    this.stopBridge();
    const enabled = this.enabledHandles();
    if (enabled.length === 0) return;

    const { bridgeScript, delegateDir, python } = this.config;
    if (!bridgeScript || !delegateDir || !python) throw new Error("The model bridge is not configured.");

    const logPath = path.join(path.dirname(bridgeScript), "bridge.log");
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(python.command, [...python.args, bridgeScript], {
      cwd: path.dirname(bridgeScript),
      env: {
        ...process.env,
        TEAM_IM_SERVER: this.config.serverUrl,
        TEAM_IM_DELEGATE_DIR: delegateDir,
        TEAM_IM_ENABLED_BOTS: enabled.join(",")
      },
      windowsHide: true,
      // bridge.py appends its structured status lines to bridge.log itself.
      // Keep stdout quiet to avoid writing each line twice; retain stderr so
      // an unhandled Python failure still lands in the same diagnostic file.
      stdio: ["ignore", "ignore", logFd]
    });
    fs.closeSync(logFd);
    this.bridge = child;

    child.once("exit", (code) => {
      if (this.bridge === child) this.bridge = null;
      if (this.intentionalBridgeStops.delete(child)) {
        return;
      }
      const detail = `Model bridge stopped unexpectedly (code ${code ?? "unknown"}).`;
      for (const handle of enabled) this.update(handle, { active: false, status: "error", detail });
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, BRIDGE_START_GRACE_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Model bridge exited immediately (code ${code ?? "unknown"}). Check bridge.log.`));
      });
    });
  }

  async shutdown(): Promise<void> {
    await this.changing;
    this.stopBridge();
    for (const handle of [...this.ownedLocalModels]) {
      const definition = DEFINITIONS.find((candidate) => candidate.handle === handle);
      if (!definition?.modelIdentifier) continue;
      try {
        await this.runLms(["unload", definition.modelIdentifier], 60_000);
      } catch {
        // LM Studio may already be gone during Windows shutdown. Its state is
        // surfaced next launch instead of blocking Team IM from exiting.
      }
      this.ownedLocalModels.delete(handle);
    }
  }
}
