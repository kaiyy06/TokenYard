import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  publint: true,
  attw: { profile: "esm-only" },
});
