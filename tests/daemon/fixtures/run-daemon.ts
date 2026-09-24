// Runs a daemon in its own process (home from ZENSPEC_HOME) and prints its port. The process
// must exit on its own once the daemon stops: no exit call, so a leaked handle would hang it.
// `ZENSPEC_DAEMON_VERSION` overrides the reported version (to test the CLI's restart on mismatch).
import { startDaemon } from "../../../src/daemon/index.js";

const daemon = await startDaemon({ port: 0, version: process.env.ZENSPEC_DAEMON_VERSION });
process.stdout.write(`${JSON.stringify({ port: daemon.port })}\n`);
