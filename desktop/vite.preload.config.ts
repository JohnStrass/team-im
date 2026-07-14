import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const entry = fileURLToPath(new URL("./electron/preload.ts", import.meta.url));

export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL("./.vite/build", import.meta.url)),
    emptyOutDir: false,
    target: "node22",
    ssr: entry,
    rollupOptions: {
      external: ["electron"],
      output: {
        entryFileNames: "preload.js",
        format: "cjs"
      }
    }
  }
});
