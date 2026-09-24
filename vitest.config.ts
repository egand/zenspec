import fs from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __ZENSPEC_VERSION__: JSON.stringify(pkg.version) },
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["legacy/**", "node_modules/**", "dist/**"],
  },
});
