import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startTestDaemon, tempDir, writeFile } from "./helpers.js";

/** A fake code-split client build, as `scripts/build.ts` lays it out. */
function clientBuild(): string {
  const dir = tempDir("client");
  writeFile(dir, "index.html", '<script type="module" src="/main.js"></script>');
  writeFile(dir, "main.js", 'import("./chunks/mermaid-ABC123.js");');
  writeFile(dir, "chunks/mermaid-ABC123.js", "export default 1;");
  writeFile(dir, "assets/KaTeX_Main-Regular-XYZ.woff2", "wOF2");
  writeFile(path.dirname(dir), "secret.txt", "nope");
  return dir;
}

describe("static client files", () => {
  it("serves code-split chunks and fonts with their MIME type", async () => {
    const { api } = await startTestDaemon({ clientDir: clientBuild() });
    const get = (p: string) => fetch(api.base + p);

    const main = await get("/main.js");
    expect(main.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(main.headers.get("cache-control")).toBe("no-cache");

    const chunk = await get("/chunks/mermaid-ABC123.js");
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(chunk.headers.get("cache-control")).toContain("immutable");
    expect(await chunk.text()).toBe("export default 1;");

    const font = await get("/assets/KaTeX_Main-Regular-XYZ.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");

    const page = await get("/d/repo/doc");
    expect(await page.text()).toContain('type="module"');
  });

  it("refuses paths outside the client folder", async () => {
    const { api } = await startTestDaemon({ clientDir: clientBuild() });
    expect((await fetch(`${api.base}/chunks/..%2F..%2Fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${api.base}/chunks/missing.js`)).status).toBe(404);
  });
});

describe("built client (npm run build)", () => {
  const dist = path.resolve(import.meta.dirname, "../../dist/client");
  const files = () => fs.readdirSync(dist, { recursive: true, encoding: "utf8" });

  it("keeps main.js small by splitting Mermaid and KaTeX into lazy chunks", () => {
    expect(fs.statSync(path.join(dist, "main.js")).size).toBeLessThan(600 * 1024);
    expect(files().some((f) => f.startsWith("chunks") && f.endsWith(".js"))).toBe(true);
    expect(fs.readFileSync(path.join(dist, "index.html"), "utf8")).toMatch(
      /<script type="module" src="\/main\.js">/,
    );
  });

  it("ships KaTeX fonts as woff2 only", () => {
    const fonts = files().filter((f) => /KaTeX_.*\.(woff2?|ttf)$/.test(f));
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every((f) => f.endsWith(".woff2"))).toBe(true);
  });
});
