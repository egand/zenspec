/** `zenspec gate` (plan §8.2, §14): exit 0 when approved or allowed, 1 when blocked. */
import path from "node:path";
import { ROUTES, type GateQuery, type GateResponse } from "../../core/api.js";
import type { DocumentRef } from "../../core/types.js";
import { parse, positionals } from "../args.js";
import type { CliContext } from "../context.js";
import { canonicalPath } from "../../daemon/identity.js";
import { connect } from "../discovery.js";
import { existingFile } from "../docs.js";
import { EXIT, type ExitCode } from "../errors.js";

const USAGE = "zenspec gate [<file>] [--repo]";

export async function gate(args: string[], ctx: CliContext): Promise<ExitCode> {
  const { values, positionals: rest } = parse(args, { repo: { type: "boolean" } });
  const [file] = positionals(rest, 0, 1, USAGE);
  const repoMode = values.repo || file === undefined;
  // In repo mode a file is the edit target: plan files and the reviewed documents stay editable.
  // Canonical, so a path through a symlink compares equal to the daemon's real paths.
  const target = file === undefined ? undefined : canonicalPath(path.resolve(ctx.cwd, file));
  const query: GateQuery = repoMode
    ? { repo: target ?? ctx.cwd }
    : { path: existingFile(ctx, file) };

  const daemon = await connect(ctx);
  const res = await daemon.get<GateResponse>(ROUTES.gate, { query });
  const blocking = res.blocking.filter((b) => !(repoMode && target && editable(target, b.doc)));
  const blocked = repoMode ? blocking.length > 0 : !res.approved;
  if (!blocked) return EXIT.ok;

  const docs = blocking.map((b) => `${b.doc.relPath} (${b.phase.replace("_", " ")})`);
  ctx.stderr.write(
    `zenspec: blocked until approved: ${docs.join(", ") || file}; wait for the review\n`,
  );
  return EXIT.blocked;
}

/** Whether `target` (canonical) is the reviewed document or under the repo's `docs/plans/`. */
function editable(target: string, doc: DocumentRef): boolean {
  const root = canonicalPath(doc.repoRoot);
  const plans = path.join(root, "docs", "plans") + path.sep;
  return target === path.join(root, doc.relPath) || target.startsWith(plans);
}
