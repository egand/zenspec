/**
 * Browser end-to-end tests (`npm run test:browser`): a real daemon, the built client in
 * `dist/client`, and headless Chrome driven by Puppeteer. Kept out of `npm test`.
 */
import fs from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __ZENSPEC_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ["tests/browser/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
