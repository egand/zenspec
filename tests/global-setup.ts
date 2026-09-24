/**
 * Builds `dist/` when it is missing or older than the sources, so tests that spawn the real
 * `dist/cli.mjs` never run a stale build (`npm test` already builds via `pretest`).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function newestMtime(p: string): number {
  const stat = fs.statSync(p);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...fs.readdirSync(p).map((f) => newestMtime(path.join(p, f))));
}

export default function setup(): void {
  const built = fs.statSync(path.join(ROOT, "dist/cli.mjs"), { throwIfNoEntry: false });
  const sources = Math.max(
    newestMtime(path.join(ROOT, "src")),
    newestMtime(path.join(ROOT, "package.json")),
  );
  if (built && built.mtimeMs >= sources) return;
  execFileSync(process.execPath, ["--import", "tsx", "scripts/build.ts"], {
    cwd: ROOT,
    stdio: "inherit",
  });
}
