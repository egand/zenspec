/** `zenspec close <file>`: close the review session from the agent side. */
import { ROUTES, type CloseRequest } from "../../core/api.js";
import { parse, positionals } from "../args.js";
import type { CliContext } from "../context.js";
import { connect } from "../discovery.js";
import { docRoute, existingFile, openDoc } from "../docs.js";

export async function close(args: string[], ctx: CliContext): Promise<void> {
  const { positionals: rest } = parse(args, {});
  const [file] = positionals(rest, 1, 1, "zenspec close <file>");
  const abs = existingFile(ctx, file);
  const daemon = await connect(ctx);
  const { doc } = await openDoc(daemon, abs);
  const body: CloseRequest = { by: "agent" };
  await daemon.post(docRoute(ROUTES.close, doc), body);
}
