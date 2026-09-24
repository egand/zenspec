/** Entry point of the `zenspec` binary (`dist/cli.mjs`). */
import { spawn } from "node:child_process";
import type { CliContext } from "./context.js";
import { runCli } from "./main.js";

const ctx: CliContext = {
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  version: __ZENSPEC_VERSION__,
  spawnDaemon() {
    const child = spawn(process.execPath, [process.argv[1], "daemon", "run"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  },
  async openUrl(url) {
    const { default: open } = await import("open");
    await open(url);
  },
};

process.exitCode = await runCli(process.argv.slice(2), ctx);
