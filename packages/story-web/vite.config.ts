import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const protocol = (file: string) => resolve(import.meta.dirname, "../protocol/src", file);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@ovst/protocol/hash", replacement: protocol("model/hash.ts") },
      { find: "@ovst/protocol/logical-path", replacement: protocol("model/logical-path.ts") },
      { find: "@ovst/protocol/logical-url", replacement: protocol("model/logical-url.ts") },
      { find: "@ovst/protocol/node-key", replacement: protocol("model/node-key.ts") },
      { find: "@ovst/protocol/sse", replacement: protocol("model/sse.ts") },
      { find: "@ovst/protocol/utf8", replacement: protocol("model/utf8.ts") },
      { find: "@ovst/protocol", replacement: protocol("index.ts") },
    ],
  },
  build: { outDir: "dist", emptyOutDir: true },
});
