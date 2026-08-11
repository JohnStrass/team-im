/**
 * Start the renderer dev server, then launch Electron against it.
 * No downloaded scaffold or shell helper is involved.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

await build({ configFile: path.join(root, "vite.main.config.ts") });
await build({ configFile: path.join(root, "vite.preload.config.ts") });

const server = await createServer({
  configFile: path.join(root, "vite.renderer.config.ts"),
  server: { host: "localhost", port: 5173, strictPort: true }
});
await server.listen();

const electronCli = path.join(root, "node_modules", "electron", "cli.js");
const child = spawn(process.execPath, [electronCli, root], {
  cwd: root,
  env: { ...process.env, VITE_DEV_SERVER_URL: "http://localhost:5173" },
  stdio: "inherit"
});

const stop = async () => {
  if (!child.killed) child.kill();
  await server.close();
};

child.on("exit", async (code) => {
  await server.close();
  process.exitCode = code ?? 0;
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
