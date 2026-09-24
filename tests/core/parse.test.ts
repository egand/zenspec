import { describe, expect, it } from "vitest";
import { classifyChange, parseDocument } from "../../src/core/parse.js";

const md = (...lines: string[]): string => lines.join("\n") + "\n";

const PLAN = md(
  "# Plan",
  "",
  "Intro paragraph.",
  "",
  "## Caching",
  "",
  "We cache reads.",
  "",
  "Writes go through.",
  "",
  "```ts",
  "const ttl = 60;",
  "```",
  "",
  "> [!QUESTION] Which database should we use?",
  ">",
  "> - [x] **(Recommended) PostgreSQL**: Reliable ACID compliance.",
  "> - [ ] SQLite: Embedded simplicity.",
  "",
  "## Implementation Steps",
  "",
  "- [ ] Build event log",
  "- [x] Write reducer",
  "  - [ ] Cover the state machine",
);

const ids = (markdown: string) => {
  const doc = parseDocument(markdown);
  return {
    blocks: doc.blocks.map((b) => b.id),
    questions: doc.questions.map((q) => q.id),
    steps: doc.steps.map((s) => s.id),
  };
};

describe("parseDocument blocks", () => {
  it("derives section-scoped block IDs with per-kind ordinals and 1-based lines", () => {
    const doc = parseDocument(PLAN);
    expect(doc.blocks.map((b) => [b.id, b.type, b.lines])).toEqual([
      ["plan", "heading", [1, 1]],
      ["plan/p1", "paragraph", [3, 3]],
      ["caching", "heading", [5, 5]],
      ["caching/p1", "paragraph", [7, 7]],
      ["caching/p2", "paragraph", [9, 9]],
      ["caching/c1", "code", [11, 13]],
      ["caching/q1", "blockquote", [15, 18]],
      ["implementation-steps", "heading", [20, 20]],
      ["implementation-steps/l1", "list", [22, 24]],
    ]);
    expect(doc.blocks[5]!.source).toBe("```ts\nconst ttl = 60;\n```");
    expect(doc.blocks[5]!.node.type).toBe("code");
  });

  it("uses `top` above the first heading and deduplicates repeated headings", () => {
    const doc = parseDocument(md("Preamble.", "", "## Notes", "", "a", "", "## Notes", "", "b"));
    expect(doc.blocks.map((b) => b.id)).toEqual([
      "top/p1",
      "notes",
      "notes/p1",
      "notes-1",
      "notes-1/p1",
    ]);
  });

  it("keeps IDs stable when content is inserted above", () => {
    const before = ids(PLAN);
    const after = ids(
      PLAN.replace("Intro paragraph.", "Intro paragraph.\n\nA new aside.\n\n- a list"),
    );
    const below = (list: string[]) => list.filter((id) => !id.startsWith("plan"));
    expect(below(after.blocks)).toEqual(below(before.blocks));
    expect(after.questions).toEqual(before.questions);
    expect(after.steps).toEqual(before.steps);
  });

  it("keeps IDs stable when an unrelated block is edited", () => {
    const edited = PLAN.replace(
      "We cache reads.",
      "We cache reads\nfor sixty seconds, then refetch.",
    );
    expect(ids(edited)).toEqual(ids(PLAN));
  });

  it("reports lines after frontmatter and parses its metadata", () => {
    const doc = parseDocument(
      md("---", "title: Plan", "tags: [a, b]", "---", "", "# Plan", "", "Body."),
    );
    expect(doc.frontmatter).toEqual({ title: "Plan", tags: ["a", "b"] });
    expect(doc.blocks.map((b) => [b.id, b.lines])).toEqual([
      ["frontmatter", [1, 4]],
      ["plan", [6, 6]],
      ["plan/p1", [8, 8]],
    ]);
  });

  it("ignores frontmatter that is not a mapping", () => {
    expect(
      parseDocument(md("---", "- just a list", "---", "", "Body.")).frontmatter,
    ).toBeUndefined();
  });
});

describe("parseDocument questions", () => {
  it("reads a single-choice question with the title on the marker line", () => {
    const [q] = parseDocument(PLAN).questions;
    expect(q).toEqual({
      id: "which-database-should-we-use",
      mode: "single",
      title: "Which database should we use?",
      block: "caching/q1",
      lines: [15, 18],
      options: ["PostgreSQL: Reliable ACID compliance.", "SQLite: Embedded simplicity."],
      recommended: "PostgreSQL: Reliable ACID compliance.",
    });
  });

  it("reads a multi-select question titled by an inner heading with plain bullets", () => {
    const [q] = parseDocument(
      md(
        "> [!QUESTION:MULTI]",
        ">",
        "> ### 1. Workforce Simulation Depth",
        ">",
        "> Which labor models fit?",
        ">",
        "> - **Macro Allocation**: headcounts.",
        "> - **(Recommended) Micro Pawn Agents**: individual characters.",
      ),
    ).questions;
    expect(q).toMatchObject({
      id: "1-workforce-simulation-depth",
      mode: "multi",
      title: "1. Workforce Simulation Depth",
      options: ["Macro Allocation: headcounts.", "Micro Pawn Agents: individual characters."],
      recommended: "Micro Pawn Agents: individual characters.",
    });
  });

  it("reads a rating question titled by its first paragraph", () => {
    const [q] = parseDocument(
      md("> [!QUESTION:RATING]", ">", "> How confident are you?"),
    ).questions;
    expect(q).toMatchObject({ id: "how-confident-are-you", mode: "rating", options: [] });
    expect(q!.recommended).toBeUndefined();
  });

  it("honors an explicit `{#id}` override and strips it from the title", () => {
    const [q] = parseDocument(
      md("> [!QUESTION] Which database? {#db-engine}", ">", "> - A", "> - B"),
    ).questions;
    expect(q).toMatchObject({ id: "db-engine", title: "Which database?" });
  });

  it("marks a checked option as recommended only, never as a selection or a step", () => {
    const doc = parseDocument(md("> [!QUESTION] Pick one", ">", "> - [ ] Alpha", "> - [x] Beta"));
    const [q] = doc.questions;
    expect(q!.recommended).toBe("Beta");
    expect(Object.keys(q!).sort()).toEqual([
      "block",
      "id",
      "lines",
      "mode",
      "options",
      "recommended",
      "title",
    ]);
    expect(doc.steps).toEqual([]);
  });

  it("keeps the question ID when its options are reworded", () => {
    const reworded = PLAN.replace("SQLite: Embedded simplicity.", "DuckDB: analytical engine.");
    expect(parseDocument(reworded).questions[0]!.id).toBe(parseDocument(PLAN).questions[0]!.id);
  });

  it("leaves ordinary blockquotes and other callouts alone", () => {
    const doc = parseDocument(md("> [!NOTE] Heads up", "", "> quoted"));
    expect(doc.questions).toEqual([]);
    expect(doc.blocks.map((b) => b.id)).toEqual(["top/b1", "top/b2"]);
  });
});

describe("parseDocument steps", () => {
  it("derives step IDs from section and text, including nested items", () => {
    expect(parseDocument(PLAN).steps).toEqual([
      {
        id: "implementation-steps/build-event-log",
        text: "Build event log",
        checked: false,
        line: 22,
        section: ["Plan", "Implementation Steps"],
      },
      {
        id: "implementation-steps/write-reducer",
        text: "Write reducer",
        checked: true,
        line: 23,
        section: ["Plan", "Implementation Steps"],
      },
      {
        id: "implementation-steps/cover-the-state-machine",
        text: "Cover the state machine",
        checked: false,
        line: 24,
        section: ["Plan", "Implementation Steps"],
      },
    ]);
  });

  it("deduplicates repeated step text and truncates long slugs at a word boundary", () => {
    const long = "Wire the daemon file watcher into the revision publisher and broadcast";
    const steps = parseDocument(md("- [ ] Test", "- [ ] Test", `- [ ] ${long}`)).steps;
    expect(steps.map((s) => s.id)).toEqual([
      "top/test",
      "top/test-1",
      "top/wire-the-daemon-file-watcher-into-the-revision",
    ]);
  });
});

describe("classifyChange", () => {
  it("reports no change for identical text", () => {
    expect(classifyChange(PLAN, PLAN)).toEqual({ kind: "none" });
  });

  it("reports checkbox-only changes with the toggled steps", () => {
    const after = PLAN.replace("- [ ] Build event log", "- [X] Build event log").replace(
      "- [x] Write reducer",
      "- [ ] Write reducer",
    );
    expect(classifyChange(PLAN, after)).toEqual({
      kind: "checkbox-only",
      steps: [
        { step: "implementation-steps/build-event-log", checked: true },
        { step: "implementation-steps/write-reducer", checked: false },
      ],
    });
  });

  it("treats a text edit alongside a tick as content", () => {
    const after = PLAN.replace("- [ ] Build event log", "- [x] Build the event log");
    expect(classifyChange(PLAN, after)).toEqual({ kind: "content" });
  });

  it("treats toggling a question option as content, not progress", () => {
    const after = PLAN.replace("> - [ ] SQLite", "> - [x] SQLite");
    expect(classifyChange(PLAN, after)).toEqual({ kind: "content" });
  });

  it("treats whitespace-only edits as content", () => {
    expect(classifyChange(PLAN, PLAN + "\n")).toEqual({ kind: "content" });
  });
});
