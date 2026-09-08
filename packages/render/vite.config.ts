import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@arbor/arborsync-client/api", replacement: resolve(import.meta.dirname, "../arborsync-client/src/api.ts") },
      { find: "@arbor/arborsync-client/configuration", replacement: resolve(import.meta.dirname, "../arborsync-client/src/configuration.ts") },
      { find: "@arbor/arborsync-client", replacement: resolve(import.meta.dirname, "../arborsync-client/src/index.ts") },
      { find: "@arbor/core/document-admission", replacement: resolve(import.meta.dirname, "../core/src/document-admission.ts") },
      { find: "@arbor/core/hash", replacement: resolve(import.meta.dirname, "../core/src/hash.ts") },
      { find: "@arbor/core/logical-path", replacement: resolve(import.meta.dirname, "../core/src/logical-path.ts") },
      { find: "@arbor/core/logical-url", replacement: resolve(import.meta.dirname, "../core/src/logical-url.ts") },
      { find: "@arbor/core/node-key", replacement: resolve(import.meta.dirname, "../core/src/node-key.ts") },
      { find: "@arbor/core/sse", replacement: resolve(import.meta.dirname, "../core/src/sse.ts") },
      { find: "@arbor/core/utf8", replacement: resolve(import.meta.dirname, "../core/src/utf8.ts") },
      { find: "@arbor/core", replacement: resolve(import.meta.dirname, "../core/src/index.ts") },
      { find: "@arbor/editor", replacement: resolve(import.meta.dirname, "../editor/src/index.ts") },
    ],
  },
  build: { outDir: "dist", emptyOutDir: true },
});
