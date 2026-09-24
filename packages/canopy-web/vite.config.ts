import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const protocol = (file: string) => resolve(import.meta.dirname, "../protocol/src", file);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@overstory/arborsync-client/api", replacement: resolve(import.meta.dirname, "../arborsync-client/src/api.ts") },
      { find: "@overstory/arborsync-client/configuration", replacement: resolve(import.meta.dirname, "../arborsync-client/src/configuration.ts") },
      { find: "@overstory/arborsync-client", replacement: resolve(import.meta.dirname, "../arborsync-client/src/index.ts") },
      { find: "@overstory/protocol/hash", replacement: protocol("model/hash.ts") },
      { find: "@overstory/protocol/logical-path", replacement: protocol("model/logical-path.ts") },
      { find: "@overstory/protocol/logical-url", replacement: protocol("model/logical-url.ts") },
      { find: "@overstory/protocol/node-key", replacement: protocol("model/node-key.ts") },
      { find: "@overstory/protocol/sse", replacement: protocol("model/sse.ts") },
      { find: "@overstory/protocol/utf8", replacement: protocol("model/utf8.ts") },
      { find: "@overstory/protocol", replacement: protocol("index.ts") },
    ],
  },
  build: { outDir: "dist", emptyOutDir: true },
});
