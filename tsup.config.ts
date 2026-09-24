import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/testing/index.ts", "src/wallet/index.ts", "src/account/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: true,
  external: ["vitest", "@stellar/stellar-sdk"],
});
