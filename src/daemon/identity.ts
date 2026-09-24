/**
 * Stable identity of a reviewed file (plan §5): `<repo-id>` is the git top-level folder name
 * plus a short hash of its path; `<doc-id>` is a slug of the repo-relative path.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DocumentKind, DocumentRef } from "../core/types.js";

export function shortHash(text: string, length = 6): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** Real path of `p`, resolving symlinks through its nearest existing ancestor. */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(canonicalPath(parent), path.basename(abs));
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Git top-level containing `p` (a file or directory), or the directory itself outside git. */
export function repoRootOf(p: string): string {
  const start = canonicalPath(p);
  const dir = isDirectory(start) ? start : path.dirname(start);
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return dir;
  }
}

/** Lowercase ASCII slug with `-` separators, e.g. `docs/plans/x.md` → `docs-plans-x-md`. */
function pathSlug(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
}

export function repoIdOf(repoRoot: string): string {
  return `${pathSlug(path.basename(repoRoot), "root")}-${shortHash(repoRoot)}`;
}

export function docIdOf(relPath: string): string {
  return pathSlug(relPath, "doc");
}

export function kindOf(file: string): DocumentKind {
  return /\.html?$/i.test(file) ? "html" : "markdown";
}

/** Identity of an absolute file path. The doc id may still need de-duplication by the caller. */
export function identify(file: string): DocumentRef {
  const abs = canonicalPath(file);
  const repoRoot = repoRootOf(abs);
  const relPath = path.relative(repoRoot, abs).split(path.sep).join("/");
  return {
    repoId: repoIdOf(repoRoot),
    docId: docIdOf(relPath),
    repoRoot,
    relPath,
    kind: kindOf(abs),
  };
}

export function absolutePath(ref: DocumentRef): string {
  return path.join(ref.repoRoot, ...ref.relPath.split("/"));
}
