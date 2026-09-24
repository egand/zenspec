import { describe, expect, it } from "vitest";
import { adrFileName, nextAdrNumber, renderAdr } from "../../src/core/adr.js";
import { decisionRecords, documentTitle } from "../../src/core/decisions.js";
import { EVENT_SCHEMA_VERSION } from "../../src/core/events.js";
import { parseDocument } from "../../src/core/parse.js";
import { replay } from "../../src/core/reducer.js";
import { PLAN, reviewedState } from "./decision-fixture.js";

const relPath = "docs/plans/storage.md";
const doc = parseDocument(PLAN);

describe("renderAdr", () => {
  it("renders a MADR record of every decision thread", () => {
    const adr = renderAdr({ relPath, state: reviewedState(), doc })!;
    const sections = adr.split("\n").filter((line) => line.startsWith("#"));
    expect(sections).toEqual([
      "# Session storage",
      "## Context and Problem Statement",
      "## Decisions",
      "### Which database engine?",
      "#### Considered Options",
      "#### Decision Outcome",
      "#### Discussion",
      "### Which modules ship first?",
      "#### Considered Options",
      "#### Decision Outcome",
    ]);
    expect(adr).toMatch(/^---\nstatus: accepted\ndate: 2026-09-24\n/);
    expect(adr).toContain("approved at revision 2 on 2026-09-24");
    expect(adr).toContain("* PostgreSQL (recommended)\n* SQLite (chosen)");
    // Plain text, never HTML-escaped.
    expect(adr).toContain('Chosen option: "SQLite", because SQLite is enough <for now>');
    expect(adr).toContain(
      "* **agent** (answered, revision 1, 2026-09-22): Switched to SQLite in the storage section",
    );
    expect(adr).toContain("* **reviewer** (resolved, review 2, 2026-09-24)");
    expect(adr).toContain('Chosen option: "auth, billing".');
    expect(adr).toContain("* auth (chosen)\n* billing (chosen)\n* search\n");
    // Non-decision threads stay out of the ADR.
    expect(adr).not.toContain("Why Redis?");
  });

  it("is proposed until the document is approved", () => {
    const adr = renderAdr({ relPath, state: reviewedState(false), doc })!;
    expect(adr).toMatch(/^---\nstatus: proposed\ndate: 2026-09-21\n/);
    expect(adr).toContain("(not approved yet)");
  });

  it("returns undefined without decision threads", () => {
    const state = replay([
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        ts: "2026-09-24T00:00:00.000Z",
        author: "agent",
        type: "revision_published",
        n: 1,
        contentHash: "h",
        summary: "",
      },
    ]);
    expect(renderAdr({ relPath, state, doc })).toBeUndefined();
  });
});

describe("decision records", () => {
  it("keeps document order and falls back to the question id when the question is gone", () => {
    const records = decisionRecords(reviewedState(), parseDocument("# Other\n"));
    expect(records.map((r) => [r.title, r.outcome])).toEqual([
      ["db-engine", "SQLite"],
      ["which-modules-ship-first", "auth, billing"],
    ]);
  });

  it("titles a document by frontmatter, first h1, or file name", () => {
    expect(documentTitle(doc, relPath)).toBe("Session storage");
    expect(documentTitle(parseDocument("## a\n\n# Real title #\n"), relPath)).toBe("Real title");
    expect(documentTitle(parseDocument("text\n"), relPath)).toBe("storage");
  });
});

describe("ADR file names", () => {
  it("numbers after the highest existing ADR", () => {
    expect(nextAdrNumber([])).toBe(1);
    expect(nextAdrNumber(["0001-a.md", "0007-b.md", "README.md", "0009-draft.txt"])).toBe(8);
  });

  it("pads the number and slugs the title", () => {
    expect(adrFileName(3, "Which database: Postgres?")).toBe("0003-which-database-postgres.md");
    expect(adrFileName(12, "x".repeat(30) + " " + "y".repeat(40))).toBe(
      `0012-${"x".repeat(30)}.md`,
    );
  });
});
