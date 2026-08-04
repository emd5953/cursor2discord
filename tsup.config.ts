import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/extension.ts"],
  outDir: "dist",
  format: ["cjs"],
  target: "node18",
  platform: "node",
  // vscode is provided by the host at runtime and must never be bundled.
  external: ["vscode"],
  // Inline every dependency into the bundle — but noExternal takes precedence
  // over external in tsup, so `vscode` has to be excluded here too.
  noExternal: [/^(?!vscode$)/],
  sourcemap: true,
  clean: true,
  minify: process.env.NODE_ENV === "production",
});
