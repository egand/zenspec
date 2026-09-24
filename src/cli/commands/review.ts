/** `zenspec review` (plan §8.1): publish, respond, open the browser once, wait, print the payload. */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
import { ROUTES, type PublishResponse, type WaitReviewResponse } from "../../core/api.js";
import type { ZenspecConfig } from "../../core/config.js";
import {
  buildClosedPayload,
  buildPendingPayload,
  formatPayloadYaml,
} from "../../core/format-payload.js";
import type { Response } from "../../core/types.js";
import {
  parse,
  parseDuration,
  parseResponseFlag,
  parseResponsesYaml,
  positionals,
} from "../args.js";
import { type CliContext, readAll, zenspecHome } from "../context.js";
import { connect } from "../discovery.js";
import { docRoute, existingFile, openDoc } from "../docs.js";
import { UnreachableError, usageError } from "../errors.js";
import type { DaemonClient } from "../http.js";

const USAGE =
  "zenspec review <file> [-m <summary>] [-r <id>:<action>[:<note>]]... [--responses-file <path|->] [--wait <duration>] [--no-open]";
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 100;

export async function review(args: string[], ctx: CliContext): Promise<void> {
  const { values, positionals: rest } = parse(args, {
    message: { type: "string", short: "m" },
    respond: { type: "string", short: "r", multiple: true },
    "responses-file": { type: "string" },
    wait: { type: "string" },
    "no-open": { type: "boolean" },
  });
  const [file] = positionals(rest, 1, 1, USAGE);
  const waitMs = values.wait === undefined ? undefined : parseDuration(values.wait);
  const responses = [
    ...(values.respond ?? []).map(parseResponseFlag),
    ...(await readResponsesFile(ctx, values["responses-file"])),
  ];
  const abs = existingFile(ctx, file);

  const daemon = await connect(ctx);
  const opened = await openDoc(daemon, abs);
  await daemon.post<PublishResponse>(docRoute(ROUTES.revisions, opened.doc), {
    author: "agent",
    ...(values.message !== undefined && { summary: values.message }),
    ...(responses.length > 0 && { responses }),
  });
  if (!opened.viewed && !values["no-open"] && openBrowserEnabled(ctx)) {
    await ctx.openUrl(opened.url).catch(() => undefined);
  }

  const route = docRoute(ROUTES.nextReview, opened.doc);
  const result = await waitForReview(ctx, daemon, route, waitMs);
  ctx.stdout.write(render(result, file, values.wait));
}

async function readResponsesFile(ctx: CliContext, source: string | undefined): Promise<Response[]> {
  if (source === undefined) return [];
  if (source === "-") return parseResponsesYaml(await readAll(ctx.stdin), "stdin");
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(ctx.cwd, source), "utf8");
  } catch {
    throw usageError(`--responses-file ${source}: cannot read file`);
  }
  return parseResponsesYaml(text, source);
}

function openBrowserEnabled(ctx: CliContext): boolean {
  try {
    const text = fs.readFileSync(path.join(zenspecHome(ctx), "config.yaml"), "utf8");
    return (parseYaml(text) as ZenspecConfig | null)?.openBrowser !== false;
  } catch {
    return true;
  }
}

/**
 * Long-poll for the first review not yet delivered to the agent: one submitted while no
 * `review` was waiting (after a `pending` timeout, or while the agent was editing) comes back
 * at once. A dropped connection is retried transparently, reconnecting (and restarting the
 * daemon if needed); the `--wait` deadline is kept across retries.
 */
async function waitForReview(
  ctx: CliContext,
  daemon: DaemonClient,
  route: string,
  waitMs: number | undefined,
): Promise<WaitReviewResponse> {
  const deadline = waitMs === undefined ? undefined : Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    const timeoutMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
    try {
      return await daemon.get<WaitReviewResponse>(route, { query: { timeoutMs } });
    } catch (err) {
      if (!(err instanceof UnreachableError) || attempt >= MAX_RETRIES) throw err;
      await delay(RETRY_BASE_MS * 2 ** attempt);
      daemon = await connect(ctx);
    }
  }
}

function render(result: WaitReviewResponse, file: string, wait: string | undefined): string {
  switch (result.status) {
    case "delivered":
      return formatPayloadYaml(result.payload);
    case "pending":
      // Built here because only the CLI knows the path and `--wait` exactly as the agent typed them.
      return formatPayloadYaml(buildPendingPayload(file, wait));
    case "closed":
      return formatPayloadYaml(buildClosedPayload(result.by, result.reason));
  }
}
