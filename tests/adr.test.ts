import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  extractDecisionsFromMarkdown,
  generateADRDocument,
  resolveDefaultAdrPath,
} from "../src/adr.js";
import { SessionState } from "../src/types.js";

describe("ADR Generation & Resolution", () => {
  it("resolves default and custom ADR paths", () => {
    const tmpFile = path.join(os.tmpdir(), "docs", "plans", "auth-rfc.md");
    const defaultPath = resolveDefaultAdrPath(tmpFile);
    expect(defaultPath).toContain("0001-auth-rfc.md");
    expect(defaultPath).toContain("adr");

    const customDest = path.join(os.tmpdir(), "custom", "decision.md");
    const resolvedCustom = resolveDefaultAdrPath(tmpFile, customDest);
    expect(resolvedCustom).toBe(customDest);
  });

  describe("extractDecisionsFromMarkdown", () => {
    it.each([
      {
        name: "single choice question with checked option",
        md: "> [!QUESTION] Database\n> - [x] Postgres\n> - [ ] MySQL",
        expectedTitle: "Database",
        expectedOption: "Postgres",
        expectedCount: 2,
      },
      {
        name: "explicit decision block with rationale",
        md: "> [!DECISION] Cache Layer\n> **Decision**: Use Redis with 1h TTL",
        expectedTitle: "Cache Layer",
        expectedOption: "Use Redis with 1h TTL",
        expectedCount: 1,
      },
      {
        name: "multi question block",
        md: "> [!QUESTION:MULTI] Modules\n> - [x] Auth\n> - [x] Billing",
        expectedTitle: "Modules",
        expectedOption: "Auth",
        expectedCount: 2,
      },
    ])("extracts decision: $name", ({ md, expectedTitle, expectedOption, expectedCount }) => {
      const decisions = extractDecisionsFromMarkdown(md);
      expect(decisions.length).toBe(1);
      expect(decisions[0].title).toBe(expectedTitle);
      expect(decisions[0].selectedOption).toContain(expectedOption);
      expect(decisions[0].allOptions.length).toBe(expectedCount);
    });
  });

  it("generates a MADR formatted Architecture Decision Record with chat transcript", () => {
    const md = `# Storage RFC
> [!QUESTION] Database Selection
> - [x] PostgreSQL
> - [ ] DynamoDB
`;
    const session: SessionState = {
      key: "test-key",
      filePath: "/project/docs/plans/storage-rfc.md",
      canonicalPath: "/project/docs/plans/storage-rfc.md",
      docType: "markdown",
      queuedPrompts: [],
      chatHistory: [
        {
          id: "msg-1",
          sender: "agent",
          text: "Proposed PostgreSQL for ACID support.",
          createdAt: "2026-08-30T10:00:00.000Z",
        },
        {
          id: "msg-2",
          sender: "user",
          text: "Agreed, looks solid.",
          createdAt: "2026-08-30T10:01:00.000Z",
        },
      ],
      presence: "waiting",
      lastModified: Date.now(),
      ended: true,
    };

    const adr = generateADRDocument({ session, docContent: md, adrNumber: 2 });
    expect(adr).toContain("# ADR-0002: Storage RFC");
    expect(adr).toContain("## Context and Problem Statement");
    expect(adr).toContain("PostgreSQL");
    expect(adr).toContain("## Considered Options & Decisions");
    expect(adr).toContain("## Review & Dialogue Transcript");
    expect(adr).toContain("🤖 Agent");
    expect(adr).toContain("👤 Reviewer");
    expect(adr).toContain("Proposed PostgreSQL for ACID support.");
  });

  it("generates fallback primary decision when no question blocks exist", () => {
    const md = `# Simple Spec\nJust plain overview.`;
    const session: SessionState = {
      key: "plain-key",
      filePath: "/project/docs/plans/plain.md",
      canonicalPath: "/project/docs/plans/plain.md",
      docType: "markdown",
      queuedPrompts: [],
      chatHistory: [],
      presence: "waiting",
      lastModified: Date.now(),
      ended: false,
    };

    const adr = generateADRDocument({ session, docContent: md });
    expect(adr).toContain("# ADR-0001: Simple Spec");
    expect(adr).toContain("Adopted architecture specification as documented in");
  });
});
