// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { MERMAID_CDN, renderExport } from "../../src/core/export/page.js";
import { MarkdownHtml } from "../../src/core/export/markdown.js";
import { parseDocument } from "../../src/core/parse.js";
import { replay } from "../../src/core/reducer.js";
import { PLAN, reviewedState } from "./decision-fixture.js";

const doc = { relPath: "docs/plans/storage.md", kind: "markdown" as const };
const exportedAt = "2026-09-25T08:00:00.000Z";

/** Parses the export and returns the element tree to query. */
function dom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const texts = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((el) => el.textContent?.replace(/\s+/g, " ").trim());

describe("renderExport", () => {
  const html = renderExport({
    doc,
    content: PLAN,
    state: reviewedState(),
    exportedAt,
    version: "1.2.3",
  });
  const page = dom(html);

  it("renders the document with the same parser, headings and all", () => {
    expect(page.title).toBe("Session storage");
    expect(texts(page, "main h1, main h2")).toEqual(["Storage plan", "Storage", "Steps"]);
    expect(page.querySelector("main h2")?.id).toBe("storage");
    expect(page.querySelector(".zen-export-meta")?.textContent).toContain("exported 2026-09-25");
    expect(page.querySelectorAll("main .zen-task input[disabled]")).toHaveLength(2);
    expect(page.querySelector("main .zen-task-done")?.textContent).toContain("Build event log");
  });

  it("is self-contained: inline CSS, math rendered at export time, raw HTML shown as text", () => {
    expect(page.querySelector("style")?.textContent).toContain(".zen-export");
    expect(page.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0);
    expect(page.querySelector("main math")).not.toBeNull();
    expect(page.querySelector("main script")).toBeNull();
    expect(texts(page, "main .zen-raw-html")).toEqual(["<script>alert(1)</script>"]);
  });

  it("keeps Mermaid as source and loads it from jsDelivr", () => {
    expect(page.querySelector("pre.mermaid")?.textContent).toBe("flowchart LR\n  A --> B");
    const scripts = [...page.querySelectorAll("script")];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.textContent).toContain(MERMAID_CDN);
    expect(html).toContain("<!-- Mermaid diagrams render in the browser");
  });

  it("marks the chosen options on question cards", () => {
    const cards = page.querySelectorAll("main .zen-question");
    expect(cards).toHaveLength(2);
    expect(texts(cards[0]!, ".zen-option-chosen")).toEqual(["SQLite (chosen)"]);
    expect(cards[0]!.textContent).toContain("PostgreSQL (recommended)");
    expect(cards[0]!.querySelector(".zen-question-answer")?.textContent).toBe(
      "Decision: SQLite · SQLite is enough <for now>",
    );
    expect(texts(cards[1]!, ".zen-option-chosen")).toEqual(["auth (chosen)", "billing (chosen)"]);
  });

  it("appends the review trail: decisions, threads with resolutions, history", () => {
    const trail = page.querySelector("#review-trail")!;
    expect(texts(trail, "h2, h3")).toEqual(["Review trail", "Decisions", "Threads", "History"]);
    expect(texts(trail, ".zen-decision strong")).toEqual([
      "Which database engine?",
      "SQLite",
      "Which modules ship first?",
      "auth, billing",
    ]);

    const threads = trail.querySelectorAll(".zen-thread");
    expect([...threads].map((t) => t.id)).toEqual([
      "thread-t1",
      "thread-t2",
      "thread-t3",
      "thread-t4",
    ]);
    const comment = trail.querySelector("#thread-t3")!;
    expect(texts(comment, ".zen-badge")).toEqual(["comment", "resolved"]);
    expect(comment.querySelector(".zen-thread-quote")?.textContent).toBe("session table");
    expect(texts(comment, ".zen-message-body")).toEqual(["Why Redis?", "Latency"]);
    expect(texts(comment, ".zen-message-head")[2]).toBe(
      "reviewer · resolved · review 2 · 2026-09-24",
    );
    expect(
      texts(trail.querySelector("#thread-t4")!, ".zen-suggestion del, .zen-suggestion ins"),
    ).toEqual(["Use Redis", "Use managed Redis"]);
    expect(texts(trail, ".zen-history li")).toEqual([
      "2026-09-20 Revision 1 published: first",
      "2026-09-21 Review 1 on revision 1 changes requested Needs work",
      "2026-09-23 Revision 2 published: addressed",
      "2026-09-24 Review 2 on revision 2 approved Ship it",
    ]);
  });

  it("embeds HTML mockups in a sandboxed iframe", () => {
    const mockup = dom(
      renderExport({
        doc: { relPath: "mock.html", kind: "html" },
        content: '<button onclick="x()">Go</button>',
        state: replay([]),
        exportedAt,
      }),
    );
    const frame = mockup.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe('<button onclick="x()">Go</button>');
    expect(texts(mockup, "#review-trail .zen-muted")).toEqual([
      "No decisions recorded.",
      "No threads.",
      "Nothing published yet.",
    ]);
  });
});

describe("MarkdownHtml", () => {
  const render = (md: string) => {
    const root = { type: "root" as const, children: parseDocument(md).blocks.map((b) => b.node) };
    return new MarkdownHtml().render(root);
  };

  it("drops unsafe URLs and opens external links in a new tab", () => {
    expect(render("[x](javascript:alert(1)) [y](https://a.b)")).toBe(
      '<p><a>x</a> <a href="https://a.b" target="_blank" rel="noopener noreferrer">y</a></p>',
    );
  });

  it("renders alerts as callouts and escapes code", () => {
    expect(render("> [!WARNING]\n> Careful")).toBe(
      '<div class="zen-callout zen-callout-warning"><div class="zen-callout-title">Warning</div><p>Careful</p></div>',
    );
    expect(render("```ts\na < b\n```")).toContain('<code class="language-ts">a &lt; b</code>');
  });
});
