import os from "node:os";
import path from "node:path";

export interface Writer {
  write(chunk: string): unknown;
}

/** Everything a command touches outside its arguments; tests substitute each part. */
export interface CliContext {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: AsyncIterable<Buffer | string>;
  stdout: Writer;
  stderr: Writer;
  version: string;
  /** Start a detached `zenspec daemon run`. */
  spawnDaemon(): void;
  openUrl(url: string): Promise<void>;
  /** How long to wait for a spawned daemon to become healthy (default 10 s). */
  startTimeoutMs?: number;
}

/** `$ZENSPEC_HOME`, or `~/.zenspec`. */
export function zenspecHome(ctx: Pick<CliContext, "env">): string {
  return ctx.env.ZENSPEC_HOME || path.join(os.homedir(), ".zenspec");
}

export async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  return text;
}
