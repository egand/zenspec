/** `zenspec export <file> [--out <path>]`: write a standalone HTML page with the review trail. */
import path from "node:path";
import { renderExport } from "../../core/export/page.js";
import { replay } from "../../core/reducer.js";
import { parse, positionals } from "../args.js";
import type { CliContext } from "../context.js";
import { fetchDocState, writeOutput } from "../docs.js";

const USAGE = "zenspec export <file> [--out <path>]";

export async function exportDoc(args: string[], ctx: CliContext): Promise<void> {
  const { values, positionals: rest } = parse(args, { out: { type: "string", short: "o" } });
  const [file] = positionals(rest, 1, 1, USAGE);
  const { doc, state } = await fetchDocState(ctx, file);
  const html = renderExport({
    doc,
    content: state.content,
    state: replay(state.events),
    exportedAt: new Date().toISOString(),
    version: ctx.version,
  });
  const abs = path.resolve(ctx.cwd, file);
  const out = values.out
    ? path.resolve(ctx.cwd, values.out)
    : path.join(path.dirname(abs), `${path.basename(abs, path.extname(abs))}.export.html`);
  writeOutput(ctx, out, html);
}
