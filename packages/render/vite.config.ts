import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@arbor/client", replacement: resolve(import.meta.dirname, "../client/src/index.ts") },
      { find: "@arbor/core/logical-path", replacement: resolve(import.meta.dirname, "../core/src/logical-path.ts") },
      { find: "@arbor/core/structural-rows", replacement: resolve(import.meta.dirname, "../core/src/structural-rows.ts") },
      { find: "@arbor/core/logical-url", replacement: resolve(import.meta.dirname, "../core/src/logical-url.ts") },
      { find: "@arbor/core/projection", replacement: resolve(import.meta.dirname, "../core/src/projection.ts") },
      { find: "@arbor/core", replacement: resolve(import.meta.dirname, "../core/src/index.ts") },
      { find: "@arbor/editor", replacement: resolve(import.meta.dirname, "../editor/src/index.ts") },
    ],
  },
  build: { outDir: "dist", emptyOutDir: true },
});
