import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CLIENT_SRC = path.join(ROOT, "src/client");
const CLIENT_DIST = path.join(DIST, "client");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  version: string;
};
const define = { __ZENSPEC_VERSION__: JSON.stringify(pkg.version) };

async function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(CLIENT_DIST, { recursive: true });

  // CLI and daemon: one Node bundle; runtime dependencies stay in node_modules.
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/cli/index.ts")],
    outfile: path.join(DIST, "cli.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    banner: { js: "#!/usr/bin/env node" },
    define,
  });
  fs.chmodSync(path.join(DIST, "cli.mjs"), 0o755);

  // Browser client: Preact with the automatic JSX runtime.
  await esbuild.build({
    entryPoints: [path.join(CLIENT_SRC, "main.tsx")],
    outdir: CLIENT_DIST,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
    define,
  });

  for (const file of fs.readdirSync(CLIENT_SRC)) {
    if (file.endsWith(".html") || file.endsWith(".css")) {
      fs.copyFileSync(path.join(CLIENT_SRC, file), path.join(CLIENT_DIST, file));
    }
  }

  console.log("Built dist/cli.mjs and dist/client/");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
