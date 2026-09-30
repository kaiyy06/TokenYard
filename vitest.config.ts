import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against source, so they do not need the gateway to be built first.
    alias: {
      "@tokenyard/gateway": fileURLToPath(
        new URL("./packages/gateway/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Live tests call paid APIs; run them explicitly with `pnpm test:live`.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    environment: "node",
  },
});
