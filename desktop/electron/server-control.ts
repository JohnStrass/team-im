/**
 * Local server supervision for the desktop app.
 *
 * The Python server is shared LAN infrastructure - other machines and agents
 * stay connected to it - so the app never stops it when the app quits. It only
 * starts a server that is missing at launch, or kills and relaunches a wedged
 * one when the user explicitly asks for a restart. Both actions are refused
 * when the configured server lives on another machine.
 *
 * This module must not import "electron" so its decision helpers stay
 * unit-testable under vitest.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SPAWN_GRACE_MS = 1_200;
const START_WAIT_MS = 10_000;
const STOP_WAIT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_500;

export interface PythonCommand {
  command: string;
  args: string[];
}

export interface ServerControlConfig {
  serverUrl: string;
  /** Ordered candidate paths for server.py; the first existing one wins. */
  scriptCandidates: readonly string[];
  configuredPython?: string;
}

export interface ServerControlState {
  serverUrl: string;
  host: string;
  port: number;
  local: boolean;
  script: string | null;
  python: PythonCommand | null;
  canManage: boolean;
}

export interface ServerActionResult {
  ok: boolean;
  error?: string;
}

export function serverHostAndPort(serverUrl: string): { host: string; port: number } {
  const parsed = new URL(serverUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  return { host, port };
}

/** True when the host names this machine, given its interface addresses. */
export function isLocalHost(host: string, addresses: readonly string[]): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return true;
  }
  return addresses.some((address) => address.trim().toLowerCase() === normalized);
}

export function machineAddresses(): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      addresses.push(entry.address);
      // "fe80::1%12" style zone suffixes never appear in a URL hostname.
      const zoneless = entry.address.replace(/%.+$/, "");
      if (zoneless !== entry.address) addresses.push(zoneless);
    }
  }
  return addresses;
}

export function pickExisting(
  candidates: readonly string[],
  exists: (candidate: string) => boolean
): string | null {
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Bare "python" is deliberately absent: on Windows it is often the Microsoft
 * Store stub, which exits silently instead of running the server. The "py"
 * launcher fallback fails loudly if Python is genuinely missing.
 */
export function choosePython(
  configured: string | undefined,
  localAppData: string | undefined,
  listDir: (dir: string) => string[],
  exists: (candidate: string) => boolean
): PythonCommand | null {
  if (configured) {
    return exists(configured) ? { command: configured, args: [] } : null;
  }

  if (localAppData) {
    const base = path.join(localAppData, "Programs", "Python");
    const versions = listDir(base)
      .map((name) => /^python3(\d*)$/i.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0));
    for (const match of versions) {
      const exe = path.join(base, match[0], "python.exe");
      if (exists(exe)) return { command: exe, args: [] };
    }
  }

  return { command: "py", args: ["-3"] };
}

export function resolveServerControl(config: ServerControlConfig): ServerControlState {
  const { host, port } = serverHostAndPort(config.serverUrl);
  const local = isLocalHost(host, machineAddresses());

  const exists = (candidate: string): boolean => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  };
  const listDir = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };

  const script = pickExisting(config.scriptCandidates, exists);
  const python = choosePython(config.configuredPython, process.env.LOCALAPPDATA, listDir, exists);

  return {
    serverUrl: config.serverUrl.replace(/\/+$/, ""),
    host,
    port,
    local,
    script,
    python,
    canManage: local && script !== null && python !== null
  };
}

/** A cheap health check: an empty tail of history, never the full page. */
export async function probeServer(
  serverUrl: string,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverUrl}/messages?since_id=2147483647`, {
      cache: "no-store",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function system32(tool: string): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", tool);
}

/**
 * Parse "netstat -ano" output into the PIDs listening on the given TCP port.
 * UDP rows have no state column and header lines have no "TCP" proto, so both
 * fall out of the column checks.
 */
export function parseListeningPids(netstatOutput: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") continue;
    if (columns[3].toUpperCase() !== "LISTENING") continue;
    const portMatch = /:(\d+)$/.exec(columns[1]);
    if (!portMatch || Number(portMatch[1]) !== port) continue;
    const pid = Number(columns[4]);
    // PIDs 0 and 4 are the Idle and System pseudo-processes; never kill those.
    if (Number.isInteger(pid) && pid > 4) pids.add(pid);
  }
  return [...pids];
}

export async function listeningPids(port: number): Promise<number[]> {
  const { stdout } = await execFileAsync(system32("netstat.exe"), ["-ano"], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  return parseListeningPids(stdout, port);
}

async function killPids(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 4) continue;
    try {
      await execFileAsync(system32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true
      });
    } catch {
      // The process already exited between netstat and taskkill.
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer(serverUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeServer(serverUrl, 1_500)) return true;
    await sleep(400);
  }
  return probeServer(serverUrl, 1_500);
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listeningPids(port)).length === 0) return true;
    await sleep(250);
  }
  return (await listeningPids(port)).length === 0;
}

/**
 * Launch server.py detached so it outlives the app, with stdout and stderr
 * appended to server.log next to the script. "-u" keeps Python unbuffered so
 * the log shows a crash immediately instead of after a buffer flush.
 */
async function startDetachedServer(state: ServerControlState): Promise<ServerActionResult> {
  const script = state.script;
  const python = state.python;
  if (!script || !python) {
    return { ok: false, error: "server.py or Python was not found on this machine." };
  }

  const serverDir = path.dirname(script);
  const logPath = path.join(serverDir, "server.log");
  let logFd: number;
  try {
    fs.appendFileSync(
      logPath,
      `--- ${new Date().toISOString()} desktop app launching ${path.basename(script)} ---\n`
    );
    logFd = fs.openSync(logPath, "a");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Unable to write server.log: ${detail}` };
  }

  try {
    return await new Promise<ServerActionResult>((resolve) => {
      const child = spawn(python.command, [...python.args, "-u", script], {
        cwd: serverDir,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd]
      });

      const settle = (result: ServerActionResult): void => {
        clearTimeout(graceTimer);
        child.removeAllListeners();
        resolve(result);
      };
      // Surviving the grace period means the interpreter is real and running;
      // an instant exit is the classic silent-stub or crash-on-start signature.
      const graceTimer = setTimeout(() => settle({ ok: true }), SPAWN_GRACE_MS);

      child.once("error", (error) =>
        settle({ ok: false, error: `Could not run ${python.command}: ${error.message}` })
      );
      child.once("exit", (code) =>
        settle({
          ok: false,
          error: `Python exited immediately (code ${code ?? "unknown"}). Check server.log next to server.py.`
        })
      );
      child.unref();
    });
  } finally {
    // The child holds its own duplicate of the descriptor.
    fs.closeSync(logFd);
  }
}

/**
 * Called once at app launch. Conservative on purpose: it spawns only when
 * nothing is listening on the port. A listener that will not answer is left
 * alone for the explicit restart action, in case someone is mid-debug on it.
 */
export async function autoStartServer(
  state: ServerControlState,
  onStatus?: (detail: string) => void
): Promise<ServerActionResult & { started: boolean }> {
  if (!state.local) return { ok: true, started: false };
  if (await probeServer(state.serverUrl)) return { ok: true, started: false };

  if (!state.canManage) {
    return {
      ok: false,
      started: false,
      error:
        "The local server is down and server.py or Python was not found. " +
        "Set serverScript and pythonPath in team-im.local.json."
    };
  }
  if ((await listeningPids(state.port)).length > 0) {
    return {
      ok: false,
      started: false,
      error: `Port ${state.port} is in use but not answering. Use "Restart server" to replace it.`
    };
  }

  onStatus?.("Starting the local team-im server...");
  const startResult = await startDetachedServer(state);
  if (!startResult.ok) return { ...startResult, started: false };

  const healthy = await waitForServer(state.serverUrl, START_WAIT_MS);
  return healthy
    ? { ok: true, started: true }
    : {
        ok: false,
        started: true,
        error: "The server was launched but is not answering. Check server.log next to server.py."
      };
}

/** The refresh action: kill whatever holds the port, then launch fresh. */
export async function restartLocalServer(
  state: ServerControlState,
  onStatus?: (detail: string) => void
): Promise<ServerActionResult> {
  if (!state.local) {
    return {
      ok: false,
      error: `The server runs on ${state.host}, not this machine, so it cannot be restarted from here.`
    };
  }
  if (!state.canManage) {
    return {
      ok: false,
      error:
        "server.py or Python was not found on this machine. " +
        "Set serverScript and pythonPath in team-im.local.json."
    };
  }

  onStatus?.("Stopping the local server...");
  await killPids(await listeningPids(state.port));
  if (!(await waitForPortFree(state.port, STOP_WAIT_MS))) {
    return {
      ok: false,
      error: `Something is still holding port ${state.port}; the old server could not be stopped.`
    };
  }

  onStatus?.("Starting the local server...");
  const startResult = await startDetachedServer(state);
  if (!startResult.ok) return startResult;

  const healthy = await waitForServer(state.serverUrl, START_WAIT_MS);
  return healthy
    ? { ok: true }
    : {
        ok: false,
        error: "The server restarted but is not answering yet. Check server.log next to server.py."
      };
}
