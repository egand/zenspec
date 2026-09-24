/** Command dispatch. Returns the exit code; never calls `process.exit`. */
import { close } from "./commands/close.js";
import { daemon } from "./commands/daemon.js";
import { gate } from "./commands/gate.js";
import { help, USAGE } from "./commands/help.js";
import { inbox, status } from "./commands/inbox.js";
import { review } from "./commands/review.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT, type ExitCode, usageError } from "./errors.js";

type Command = (args: string[], ctx: CliContext) => Promise<ExitCode | void> | ExitCode | void;

const notImplemented =
  (name: string): Command =>
  () => {
    throw usageError(`${name} is not implemented yet`);
  };

const COMMANDS: Record<string, Command> = {
  review,
  gate,
  close,
  status,
  inbox,
  daemon,
  help,
  adr: notImplemented("adr"),
  export: notImplemented("export"),
};

export async function runCli(argv: string[], ctx: CliContext): Promise<ExitCode> {
  const [name, ...args] = argv;
  if (name === "--version" || name === "-v") {
    ctx.stdout.write(`${ctx.version}\n`);
    return EXIT.ok;
  }
  if (name === "--help" || name === "-h") return runCli(["help", ...args], ctx);
  if (name !== "help" && (args.includes("--help") || args.includes("-h"))) {
    return runCli(["help", name], ctx);
  }
  const command = name === undefined ? undefined : Object.hasOwn(COMMANDS, name) && COMMANDS[name];
  try {
    if (!command)
      throw usageError(name === undefined ? USAGE : `unknown command: ${name}\n${USAGE}`);
    return (await command(args, ctx)) ?? EXIT.ok;
  } catch (err) {
    const error = err instanceof CliError ? err : new CliError(String(err), EXIT.failure);
    ctx.stderr.write(`zenspec: ${error.message}\n`);
    return error.exitCode;
  }
}
