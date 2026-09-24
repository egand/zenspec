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

/**
 * KaTeX's stylesheet lists woff2, woff and ttf for every font. Every browser we target reads
 * woff2, so the other formats are dropped from the CSS and never bundled.
 */
const katexWoff2Only: esbuild.Plugin = {
  name: "katex-woff2-only",
  setup(b) {
    b.onLoad({ filter: /katex[\\/]dist[\\/]katex(\.min)?\.css$/ }, async (args) => {
      const css = await fs.promises.readFile(args.path, "utf8");
      const contents = css.replace(
        /,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g,
        "",
      );
      return { contents, loader: "css", resolveDir: path.dirname(args.path) };
    });
  },
};

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

  // Browser client: Preact with the automatic JSX runtime. Code splitting keeps rarely used
  // heavy libraries (Mermaid, KaTeX) out of `main.js`: they load via dynamic `import()`.
  const client = await esbuild.build({
    entryPoints: [path.join(CLIENT_SRC, "main.tsx")],
    outdir: CLIENT_DIST,
    bundle: true,
    splitting: true,
    minify: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    loader: { ".woff2": "file" },
    plugins: [katexWoff2Only],
    metafile: true,
    define,
  });

  for (const file of fs.readdirSync(CLIENT_SRC)) {
    if (file.endsWith(".html") || file.endsWith(".css")) {
      fs.copyFileSync(path.join(CLIENT_SRC, file), path.join(CLIENT_DIST, file));
    }
  }

  const main = client.metafile.outputs[path.relative(ROOT, path.join(CLIENT_DIST, "main.js"))];
  const kb = main ? `, main.js ${Math.round(main.bytes / 1024)} KB` : "";
  console.log(`Built dist/cli.mjs and dist/client/${kb}`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
