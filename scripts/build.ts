import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const CLIENT_DIST = path.join(DIST, "client");

async function build() {
  console.log("🔨 Building ZenSpec...");

  // Ensure dist directories exist
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(CLIENT_DIST, { recursive: true });

  // 1. Build CLI & Server bundle
  console.log("  → Bundling CLI (dist/cli.mjs)...");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/cli.ts")],
    outfile: path.join(DIST, "cli.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: `#!/usr/bin/env node\nimport { createRequire } from 'module';\nconst require = createRequire(import.meta.url);`,
    },
    external: ["chokidar", "open", "picocolors", "cross-spawn"],
  });

  // Make executable
  fs.chmodSync(path.join(DIST, "cli.mjs"), 0o755);

  // 2. Build Client app.ts
  console.log("  → Bundling Client (dist/client/app.js)...");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/client/app.ts")],
    outfile: path.join(CLIENT_DIST, "app.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
  });

  // 3. Copy static client assets
  console.log("  → Copying HTML & CSS assets...");
  fs.copyFileSync(path.join(ROOT, "src/client/index.html"), path.join(CLIENT_DIST, "index.html"));
  fs.copyFileSync(path.join(ROOT, "src/client/styles.css"), path.join(CLIENT_DIST, "styles.css"));

  console.log("✨ ZenSpec build complete!");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
