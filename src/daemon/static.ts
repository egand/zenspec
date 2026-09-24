/** Serves the built browser client (`dist/client/`) for page routes and its assets. */
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

const PLACEHOLDER = `<!doctype html><html lang="en"><meta charset="utf-8"><title>ZenSpec</title>
<p>The ZenSpec client is not built. Run <code>npm run build</code>.</p></html>`;

/** `dist/client` next to the bundled CLI, or relative to the sources when run unbundled. */
export function defaultClientDir(): string {
  const candidates = [
    fileURLToPath(new URL("./client", import.meta.url)),
    fileURLToPath(new URL("../../dist/client", import.meta.url)),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0]!;
}

export function serveIndex(res: ServerResponse, clientDir: string): void {
  if (!serveFile(res, clientDir, "index.html")) {
    res.writeHead(200, { "Content-Type": TYPES[".html"]! });
    res.end(PLACEHOLDER);
  }
}

/** Serves `clientDir/<relative>` if it exists inside `clientDir`. Returns whether it did. */
export function serveFile(res: ServerResponse, clientDir: string, relative: string): boolean {
  const root = path.resolve(clientDir);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) return false;
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(body);
  return true;
}
