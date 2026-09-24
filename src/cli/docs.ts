import fs from "node:fs";
import path from "node:path";
import { fillPath, ROUTES, type OpenDocResponse } from "../core/api.js";
import type { DocumentRef } from "../core/types.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT } from "./errors.js";
import type { DaemonClient } from "./http.js";

/** Absolute path of an existing file argument. */
export function existingFile(ctx: CliContext, file: string): string {
  const abs = path.resolve(ctx.cwd, file);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) {
    throw new CliError(`no such file: ${file}`, EXIT.notFound);
  }
  return abs;
}

/** Register (or look up) the document for an absolute path. */
export function openDoc(daemon: DaemonClient, abs: string): Promise<OpenDocResponse> {
  return daemon.post<OpenDocResponse>(ROUTES.docs, { path: abs });
}

/** A per-document route filled with the document's ids. */
export function docRoute(template: string, doc: Pick<DocumentRef, "repoId" | "docId">): string {
  return fillPath(template, { repoId: doc.repoId, docId: doc.docId });
}
