import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

describe("CLI Export Command", () => {
  it("exports standalone self-contained HTML from a Markdown file", () => {
    const testFile = path.join(os.tmpdir(), `zen-cli-test-${Date.now()}.md`);
    const outFile = path.join(os.tmpdir(), `zen-cli-test-${Date.now()}.export.html`);

    fs.writeFileSync(
      testFile,
      "# Architecture Plan\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\nFormula: $a^2 + b^2 = c^2$",
      "utf8",
    );

    try {
      execSync(`node --import tsx src/cli.ts export "${testFile}" --out "${outFile}"`, {
        cwd: path.resolve(__dirname, ".."),
        stdio: "pipe",
      });

      expect(fs.existsSync(outFile)).toBe(true);
      const exportedHtml = fs.readFileSync(outFile, "utf8");
      expect(exportedHtml).toContain("Architecture Plan");
      expect(exportedHtml).toContain("katex.min.css");
      expect(exportedHtml).toContain("mermaid.min.js");
      expect(exportedHtml).toContain("graph TD;");
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });
});
