import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // Keep the per-model report (answers, tokens, cost, latency) visible on passing runs.
    silent: false,
  },
});
