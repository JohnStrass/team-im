/** Build the Electron main process, preload bridge, and React renderer. */
import { build } from "vite";
import { fileURLToPath, URL } from "node:url";

for (const configFile of [
  "vite.main.config.ts",
  "vite.preload.config.ts",
  "vite.renderer.config.ts"
]) {
  await build({ configFile: fileURLToPath(new URL(`../${configFile}`, import.meta.url)) });
}
