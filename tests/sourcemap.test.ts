import { describe, it, expect } from "vitest";
import {
  extractBlockLineRanges,
  parseFrontmatter,
  renderMarkdownWithSourceLines,
} from "../src/sourcemap.js";

describe("Markdown Source-Line Mapping & AST Renderer", () => {
  it("extracts line ranges accurately for headings, paragraphs, and code blocks", () => {
    const md = `# Title (Line 1)

Paragraph 1 line 1
Paragraph 1 line 2

\`\`\`javascript
const a = 1;
const b = 2;
\`\`\`

- Item 1
- Item 2`;

    const ranges = extractBlockLineRanges(md);
    expect(ranges.length).toBeGreaterThan(0);

    // Title should be line 1
    expect(ranges[0]).toEqual({ startLine: 1, endLine: 1 });

    // Paragraph 1 should start at line 3 and end at line 4
    expect(ranges[1]).toEqual({ startLine: 3, endLine: 4 });

    // Code block should be lines 6 to 9
    expect(ranges[2]).toEqual({ startLine: 6, endLine: 9 });
  });

  it("injects data-line-start and data-line-end into rendered HTML tags", () => {
    const md = `## Section A
This is a test paragraph.

> [!QUESTION] Which database should we use?
> - [ ] PostgreSQL
> - [ ] SQLite`;

    const html = renderMarkdownWithSourceLines(md);

    expect(html).toContain('data-line-start="1"');
    expect(html).toContain('data-line-end="1"');
    expect(html).toContain("<h2");

    expect(html).toContain('data-line-start="2"');
    expect(html).toContain("<p");

    expect(html).toContain("zen-callout-question");
    expect(html).toContain("Which database should we use?");
  });

  describe("YAML Frontmatter Parsing & Card Rendering", () => {
    it.each([
      {
        name: "multiline list tags",
        input: "---\ntitle: Doc A\ntags:\n  - tag1\n  - tag2\n---\n# Body",
        expectedTitle: "Doc A",
        expectedTags: ["tag1", "tag2"],
      },
      {
        name: "inline array tags",
        input: '---\ntitle: Doc B\ntags: ["alpha", "beta"]\n---\n# Body',
        expectedTitle: "Doc B",
        expectedTags: ["alpha", "beta"],
      },
      {
        name: "quoted scalar strings",
        input: "---\ntitle: \"Quoted Title\"\nauthor: 'Jane Doe'\n---\n# Body",
        expectedTitle: "Quoted Title",
        expectedAuthor: "Jane Doe",
      },
    ])("parses frontmatter: $name", ({ input, expectedTitle, expectedTags, expectedAuthor }) => {
      const { metadata, body, frontmatterLines } = parseFrontmatter(input);
      expect(metadata).not.toBeNull();
      expect(metadata?.title).toBe(expectedTitle);
      if (expectedTags) expect(metadata?.tags).toEqual(expectedTags);
      if (expectedAuthor) expect(metadata?.author).toBe(expectedAuthor);
      expect(body.trim()).toBe("# Body");
      expect(frontmatterLines).toBeGreaterThan(0);

      const html = renderMarkdownWithSourceLines(input);
      expect(html).toContain("zen-frontmatter-card");
      expect(html).toContain(expectedTitle);
    });

    it("returns null metadata when frontmatter is absent", () => {
      const md = "# No Frontmatter\nJust plain text.";
      const { metadata, body, frontmatterLines } = parseFrontmatter(md);
      expect(metadata).toBeNull();
      expect(body).toBe(md);
      expect(frontmatterLines).toBe(0);
    });
  });

  describe("GFM Admonitions & Callouts", () => {
    it.each(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])(
      "renders [!%s] callouts with correct CSS class",
      (type) => {
        const md = `> [!${type}] This is an alert message of type ${type}.`;
        const html = renderMarkdownWithSourceLines(md);
        expect(html).toContain(`zen-callout zen-callout-${type.toLowerCase()}`);
        expect(html).toContain(type);
        expect(html).toContain(`This is an alert message of type ${type}.`);
      },
    );
  });

  describe("Interactive Question Callouts", () => {
    it.each([
      { tag: "QUESTION", mode: "single", inputType: "radio", label: "" },
      { tag: "QUESTION:MULTI", mode: "multi", inputType: "checkbox", label: "Multi-Select" },
      { tag: "QUESTION:CHECKBOX", mode: "checkbox", inputType: "checkbox", label: "Multi-Select" },
    ])("renders $tag callouts with $inputType inputs", ({ tag, mode, inputType, label }) => {
      const md = `> [!${tag}] Select features
> - [x] Feature A
> - [ ] Feature B`;

      const html = renderMarkdownWithSourceLines(md);
      expect(html).toContain(`data-question-mode="${mode}"`);
      expect(html).toContain(`type="${inputType}"`);
      expect(html).toContain("Feature A");
      expect(html).toContain("Feature B");
      if (label) expect(html).toContain(label);
    });

    it.each(["QUESTION:RATING", "QUESTION:SCALE"])(
      "renders %s callouts with 1-5 star rating buttons",
      (tag) => {
        const md = `> [!${tag}] Rate this architecture proposal`;
        const html = renderMarkdownWithSourceLines(md);
        const expectedMode = tag.split(":")[1].toLowerCase();
        expect(html).toContain(`data-question-mode="${expectedMode}"`);
        expect(html).toContain("zen-rating-group");
        expect(html).toContain('data-value="1"');
        expect(html).toContain('data-value="5"');
        expect(html).toContain("Rating (1-5)");
      },
    );
  });

  describe("Math & Currency Expressions", () => {
    it.each([
      { name: "display math", md: "$$\\sum_{i=1}^n x_i$$", expectKatex: true },
      {
        name: "inline math variable",
        md: "Let $x \\in \\mathbb{R}$ be a variable.",
        expectKatex: true,
      },
      { name: "inline math formula", md: "Formula $E = mc^2$ in physics.", expectKatex: true },
      { name: "single currency amount", md: "The cost is $100 per user.", expectKatex: false },
      { name: "two currency amounts", md: "Between $50 and $200 per month.", expectKatex: false },
      { name: "decimal currency", md: "Discount is $19.99 today.", expectKatex: false },
    ])("handles $name correctly (katex: $expectKatex)", ({ md, expectKatex }) => {
      const html = renderMarkdownWithSourceLines(md);
      if (expectKatex) {
        expect(html).toContain("katex");
      } else {
        expect(html).not.toContain("katex-display");
        expect(html).not.toContain('<span class="katex">');
      }
    });
  });

  describe("Code Blocks, Tables, and Diagrams", () => {
    it.each([
      { lang: "typescript", code: "const x: number = 42;" },
      { lang: "python", code: "def add(a, b):\n    return a + b" },
      { lang: "rust", code: 'fn main() { println!("hi"); }' },
      { lang: "", code: "plain text log" },
    ])("renders code block for language '$lang'", ({ lang, code }) => {
      const md = `\`\`\`${lang}\n${code}\n\`\`\``;
      const html = renderMarkdownWithSourceLines(md);
      expect(html).toContain("zen-code-block-wrapper");
      expect(html).toContain("zen-code-copy-btn");
      if (lang) {
        expect(html).toContain(`data-lang="${lang}"`);
        expect(html).toContain(`<span class="zen-code-lang">${lang}</span>`);
      }
    });

    it("renders Mermaid diagrams with action button", () => {
      const md = "```mermaid\ngraph LR;\n  A-->B;\n```";
      const html = renderMarkdownWithSourceLines(md);
      expect(html).toContain("zen-mermaid-container");
      expect(html).toContain("zen-diagram-comment-btn");
      expect(html).toContain("graph LR;");
    });

    it("renders Markdown tables with line-anchored wrappers", () => {
      const md = `| Header 1 | Header 2 |
| :--- | :--- |
| Val 1 | Val 2 |`;

      const html = renderMarkdownWithSourceLines(md);
      expect(html).toContain("zen-table-wrapper");
      expect(html).toContain('<table class="zen-table">');
      expect(html).toContain("<th>Header 1</th>");
      expect(html).toContain("<td>Val 1</td>");
    });

    it("renders task list items with checkboxes", () => {
      const md = `- [x] Completed task\n- [ ] Pending task`;
      const html = renderMarkdownWithSourceLines(md);
      expect(html).toContain("zen-task-item");
      expect(html).toContain("zen-task-checkbox");
      expect(html).toContain("checked");
      expect(html).toContain("Completed task");
      expect(html).toContain("Pending task");
    });

    it("renders footnote references properly", () => {
      const md = `Statement[^ref1].\n\n[^ref1]: Note details.`;
      const html = renderMarkdownWithSourceLines(md);
      expect(html).toContain("zen-footnote-ref");
      expect(html).toContain("#fn-ref1");
    });
  });
});
