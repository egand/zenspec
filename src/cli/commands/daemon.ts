/** `zenspec daemon run|stop|status` (plan §13). */
import { parse, positionals } from "../args.js";
import { type CliContext, zenspecHome } from "../context.js";
import { probe, readDaemonInfo, stopDaemon } from "../discovery.js";
import { EXIT, type ExitCode, usageError } from "../errors.js";

const USAGE = "zenspec daemon run|stop|status";

export async function daemon(args: string[], ctx: CliContext): Promise<ExitCode> {
  const [action] = positionals(parse(args, {}).positionals, 1, 1, USAGE);
  switch (action) {
    case "run":
      await run(ctx);
      return EXIT.ok;
    case "stop": {
      const info = readDaemonInfo(ctx);
      const health = info && (await probe(info.port));
      if (health) await stopDaemon(health.port, health.pid);
      return EXIT.ok;
    }
    case "status": {
      const info = readDaemonInfo(ctx);
      const health = info && (await probe(info.port));
      if (!health) {
        ctx.stdout.write("not running\n");
        return EXIT.unreachable;
      }
      ctx.stdout.write(`running pid ${health.pid} port ${health.port} version ${health.version}\n`);
      return EXIT.ok;
    }
    default:
      throw usageError(`usage: ${USAGE}`);
  }
}

/** Foreground daemon; it records and clears `daemon.json` and exits once stopped. */
async function run(ctx: CliContext): Promise<void> {
  // Imported lazily so other commands never load the daemon's dependencies.
  const { startDaemon } = await import("../../daemon/index.js");
  const handle = await startDaemon({
    home: zenspecHome(ctx),
    version: ctx.version,
    exitProcess: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void handle.stop());
  await handle.stopped;
}
