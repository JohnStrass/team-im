/**
 * Live integration coverage for the spawn/kill machinery behind auto-start and
 * the "Restart server" button. Runs a throwaway stdlib server on a scratch
 * port, so it exercises real netstat, taskkill, and detached spawning without
 * touching a real team-im server. Skips itself when it is not on Windows, when
 * no Python is available, or when something else already owns the scratch port.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  autoStartServer,
  choosePython,
  listeningPids,
  probeServer,
  restartLocalServer,
  type PythonCommand,
  type ServerControlState,
} from "../electron/server-control";

const execFileAsync = promisify(execFile);

const SCRATCH_PORT = 8971;
const SCRATCH_URL = `http://127.0.0.1:${SCRATCH_PORT}`;

const SCRATCH_SERVER = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        pass
    def do_GET(self):
        body = json.dumps([]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ThreadingHTTPServer(("127.0.0.1", ${SCRATCH_PORT}), Handler).serve_forever()
`;

let scratchDir: string | null = null;
let python: PythonCommand | null = null;
let portWasFree = false;

async function pythonWorks(candidate: PythonCommand): Promise<boolean> {
  try {
    await execFileAsync(candidate.command, [...candidate.args, "-c", "print(1)"], {
      windowsHide: true,
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function killScratchListeners(): Promise<void> {
  for (const pid of await listeningPids(SCRATCH_PORT)) {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      // Already exited.
    }
  }
}

beforeAll(async () => {
  if (process.platform !== "win32") return;
  portWasFree = (await listeningPids(SCRATCH_PORT)).length === 0;
  if (!portWasFree) return;

  const candidate = choosePython(
    undefined,
    process.env.LOCALAPPDATA,
    (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    (candidatePath) => {
      try {
        return fs.existsSync(candidatePath);
      } catch {
        return false;
      }
    },
  );
  if (!candidate || !(await pythonWorks(candidate))) return;
  python = candidate;

  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-im-spawn-test-"));
  fs.writeFileSync(path.join(scratchDir, "server.py"), SCRATCH_SERVER, "utf8");
}, 30_000);

afterAll(async () => {
  if (portWasFree) await killScratchListeners();
  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
}, 30_000);

describe("server supervision on a scratch port", () => {
  it("auto-starts a missing server, then restart replaces its process", async (ctx) => {
    if (process.platform !== "win32" || !portWasFree || !python || !scratchDir) {
      ctx.skip();
      return;
    }

    const state: ServerControlState = {
      serverUrl: SCRATCH_URL,
      host: "127.0.0.1",
      port: SCRATCH_PORT,
      local: true,
      script: path.join(scratchDir, "server.py"),
      python,
      canManage: true,
    };

    // Nothing is listening, so auto-start must spawn and reach a healthy probe.
    const started = await autoStartServer(state);
    expect(started).toMatchObject({ ok: true, started: true });
    const firstPids = await listeningPids(SCRATCH_PORT);
    expect(firstPids).toHaveLength(1);
    expect(await probeServer(SCRATCH_URL)).toBe(true);

    // A healthy server means a second auto-start must not spawn anything.
    const secondStart = await autoStartServer(state);
    expect(secondStart).toMatchObject({ ok: true, started: false });
    expect(await listeningPids(SCRATCH_PORT)).toEqual(firstPids);

    // Restart must kill the old process and bring up a different one.
    const restarted = await restartLocalServer(state);
    expect(restarted).toMatchObject({ ok: true });
    const secondPids = await listeningPids(SCRATCH_PORT);
    expect(secondPids).toHaveLength(1);
    expect(secondPids[0]).not.toBe(firstPids[0]);
    expect(await probeServer(SCRATCH_URL)).toBe(true);
  }, 60_000);
});
