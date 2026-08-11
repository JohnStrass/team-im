import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Browser build. Emits a plain static bundle for server.py to serve, so the
 * room works on a phone. The Electron build is a SEPARATE config and must not
 * be affected by anything here.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("./../web", import.meta.url)),
    emptyOutDir: true,

    // Deliberately UNMINIFIED, and this is a security decision rather than a
    // debugging convenience.
    //
    // The machine that builds this bundle is not the machine that serves it, so
    // whoever deploys it is accepting an artifact they did not produce. Minified
    // output makes that an act of trust; readable output makes it an act of
    // review. The cost is 557KB instead of 222KB, which over a LAN is nothing.
    //
    // The check that actually matters is cheap and repeatable by anyone:
    //   grep -oE "fetch\(|XMLHttpRequest|WebSocket|EventSource\(" web/assets/*.js
    //   grep -oE "https?://[^\"')]+" web/assets/*.js | sort -u
    // As of this build that is three network call sites - all same-origin - and
    // zero external hosts (the only absolute URLs are W3C namespace constants
    // and a React error-docs link, neither of which is fetched).
    //
    // Note this is NOT a substitute for trusting the dependency tree: the same
    // React ships either way. It only removes the "nobody can read what is
    // deployed" problem, which was the one real weakness of shipping prebuilt.
    minify: false,
  },
  plugins: [react()],
});
