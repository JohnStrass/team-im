/**
 * Create a portable Windows app without third-party installer tooling.
 * Electron already ships as a complete Windows directory; we copy it and add
 * only our pre-built application under resources/app.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const projectRoot = path.resolve(root, "..");
const electronDist = path.join(root, "node_modules", "electron", "dist");
const output = path.join(root, "out", "team-im-win32-x64");
const appDir = path.join(output, "resources", "app");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.cp(electronDist, output, { recursive: true });

await fs.rename(path.join(output, "electron.exe"), path.join(output, "team-im.exe"));
await fs.rm(path.join(output, "resources", "default_app.asar"), { force: true });
await fs.mkdir(appDir, { recursive: true });
await fs.cp(path.join(root, ".vite"), path.join(appDir, ".vite"), { recursive: true });
const packagedHtml = path.join(appDir, ".vite", "renderer", "main_window", "index.html");
const html = await fs.readFile(packagedHtml, "utf8");
await fs.writeFile(
  packagedHtml,
  html.replace(
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:5173",
    "style-src 'self'; img-src 'self' data:; connect-src 'none'"
  ),
  "utf8"
);
await fs.copyFile(path.join(projectRoot, "LICENSE"), path.join(appDir, "LICENSE"));
try {
  await fs.copyFile(path.join(root, "team-im.local.json"), path.join(output, "team-im.local.json"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await fs.writeFile(
  path.join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "team-im-desktop",
      productName: "team-im",
      version: "0.1.0",
      main: ".vite/build/main.js"
    },
    null,
    2
  ) + "\n",
  "utf8"
);

console.log(`Portable app created at ${output}`);
