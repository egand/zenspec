/** `zenspec status` (open reviews in this repo) and `zenspec inbox` (all repos, or `--pending`). */
import path from "node:path";
import {
  ROUTES,
  type InboxItem,
  type InboxPendingRequest,
  type InboxPendingResponse,
  type InboxResponse,
} from "../../core/api.js";
import { formatPayloadYaml } from "../../core/format-payload.js";
import { parse, positionals } from "../args.js";
import type { CliContext } from "../context.js";
import { connect } from "../discovery.js";

export async function status(args: string[], ctx: CliContext): Promise<void> {
  positionals(parse(args, {}).positionals, 0, 0, "zenspec status");
  const daemon = await connect(ctx);
  const { items } = await daemon.get<InboxResponse>(ROUTES.inbox, { query: { repo: ctx.cwd } });
  const open = items.filter((item) => item.doc.phase !== "done");
  ctx.stdout.write(
    open.length ? open.map((i) => line(i, i.doc.relPath)).join("") : "no open reviews\n",
  );
}

export async function inbox(args: string[], ctx: CliContext): Promise<void> {
  const { values, positionals: rest } = parse(args, { pending: { type: "boolean" } });
  positionals(rest, 0, 0, "zenspec inbox [--pending]");
  const daemon = await connect(ctx);
  if (values.pending) {
    // Hook output: silent when nothing is new, so it costs no tokens.
    const body: InboxPendingRequest = { repo: ctx.cwd };
    const { items } = await daemon.post<InboxPendingResponse>(ROUTES.inboxPending, body);
    for (const { doc, payload } of items) {
      ctx.stdout.write(`# ${doc.relPath}\n${formatPayloadYaml(payload)}`);
    }
    return;
  }
  const { items } = await daemon.get<InboxResponse>(ROUTES.inbox);
  ctx.stdout.write(items.map((i) => line(i, path.join(i.doc.repoRoot, i.doc.relPath))).join(""));
}

function line(item: InboxItem, name: string): string {
  const verdict = item.lastVerdict ? ` ${item.lastVerdict}` : "";
  return `${name} ${item.doc.phase} rev ${item.lastRevision}${verdict} ${item.openThreads} open ${item.url}\n`;
}
