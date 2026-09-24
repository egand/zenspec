import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli.mjs", import.meta.url));

it("prints the version from the built binary", () => {
  expect(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" })).toBe(
    `${__ZENSPEC_VERSION__}\n`,
  );
});
