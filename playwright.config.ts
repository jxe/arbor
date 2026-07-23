import { defineConfig } from "@playwright/test";

const port = Number(process.env.ARBOR_E2E_PORT ?? 4321);

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: "bun tests/e2e/server.ts",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
