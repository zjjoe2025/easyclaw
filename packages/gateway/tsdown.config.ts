import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/volcengine-stt-cli.ts"],
  format: "esm",
  dts: true,
  clean: true,
  // zod is bundled because we import the vendor OpenClaw Zod schema
  // (used by stripUnknownKeys in config-writer.ts).
  inlineOnly: ["zod"],
});
