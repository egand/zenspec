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

  it("prints version on --version", () => {
    const output = execSync("node --import tsx src/cli.ts --version", {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });
    expect(output).toContain("zen-axi v0.1.0");
  });

  it("prints help on --help", () => {
    const output = execSync("node --import tsx src/cli.ts --help", {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });
    expect(output).toContain("Zen AXI");
    expect(output).toContain("zen-axi poll");
    expect(output).toContain("zen-axi progress");
    expect(output).toContain("zen-axi adr");
    expect(output).toContain("zen-axi mcp");
  });

  it("generates an ADR file via CLI adr command", () => {
    const testFile = path.join(os.tmpdir(), `zen-adr-cli-${Date.now()}.md`);
    const outAdr = path.join(os.tmpdir(), `zen-adr-cli-${Date.now()}.adr.md`);

    fs.writeFileSync(
      testFile,
      "# CLI Test Spec\n\n> [!QUESTION] Choose framework\n> - [x] Fastify\n> - [ ] Express\n",
      "utf8",
    );

    try {
      execSync(`node --import tsx src/cli.ts adr "${testFile}" --out "${outAdr}"`, {
        cwd: path.resolve(__dirname, ".."),
        stdio: "pipe",
      });

      expect(fs.existsSync(outAdr)).toBe(true);
      const adrContent = fs.readFileSync(outAdr, "utf8");
      expect(adrContent).toContain("# ADR-0001: CLI Test Spec");
      expect(adrContent).toContain("Fastify");
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
      if (fs.existsSync(outAdr)) fs.unlinkSync(outAdr);
    }
  });
});
