import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Live tests call paid APIs; run them explicitly with `pnpm test:live`.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    environment: "node",
  },
});
