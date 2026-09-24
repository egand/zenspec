/** `zenspec adr <file> [--out <path>]`: write a MADR-style ADR from the decision threads. */
import fs from "node:fs";
import path from "node:path";
import { adrFileName, nextAdrNumber, renderAdr } from "../../core/adr.js";
import { documentTitle } from "../../core/decisions.js";
import { parseDocument } from "../../core/parse.js";
import { replay } from "../../core/reducer.js";
import { parse, positionals } from "../args.js";
import type { CliContext } from "../context.js";
import { fetchDocState, writeOutput } from "../docs.js";
import { CliError, EXIT } from "../errors.js";

const USAGE = "zenspec adr <file> [--out <path>]";

export async function adr(args: string[], ctx: CliContext): Promise<void> {
  const { values, positionals: rest } = parse(args, { out: { type: "string", short: "o" } });
  const [file] = positionals(rest, 1, 1, USAGE);
  const { doc, state } = await fetchDocState(ctx, file);
  const parsed = parseDocument(state.content);
  const text = renderAdr({ relPath: doc.relPath, state: replay(state.events), doc: parsed });
  if (text === undefined) throw new CliError(`no decision threads in ${file}`, EXIT.notFound);
  writeOutput(ctx, values.out ? path.resolve(ctx.cwd, values.out) : defaultPath(doc, parsed), text);
}

/** `docs/adr/NNNN-<slug>.md` in the document's repo, numbered after the existing ADRs. */
function defaultPath(
  doc: { repoRoot: string; relPath: string },
  parsed: ReturnType<typeof parseDocument>,
): string {
  const dir = path.join(doc.repoRoot, "docs", "adr");
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return path.join(dir, adrFileName(nextAdrNumber(existing), documentTitle(parsed, doc.relPath)));
}
