import { describe, it, expect } from "vitest";
import { extractBlockLineRanges, renderMarkdownWithSourceLines } from "../src/sourcemap.js";

describe("Markdown Source-Line Mapping", () => {
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

  it("renders Mermaid containers with action buttons", () => {
    const md = `\`\`\`mermaid
graph TD;
  A-->B;
\`\`\``;

    const html = renderMarkdownWithSourceLines(md);
    expect(html).toContain("zen-mermaid-container");
    expect(html).toContain("zen-diagram-comment-btn");
    expect(html).toContain("graph TD;");
  });

  it("renders Markdown tables with line-anchored wrappers", () => {
    const md = `| Feature | Status |
| :--- | :--- |
| Auth | Complete |
| Database | Pending |`;

    const html = renderMarkdownWithSourceLines(md);
    expect(html).toContain("zen-table-wrapper");
    expect(html).toContain('<table class="zen-table">');
    expect(html).toContain("<th>Feature</th>");
    expect(html).toContain("<td>Auth</td>");
  });

  it("pre-renders KaTeX math formulas with zero Markdown underscore corruption", () => {
    const md = `The formula is: $$\\eta = 1 - \\frac{\\text{Tokens}_{\\text{Markdown}}}{\\text{Tokens}_{\\text{HTML}}} \\approx 0.72$$ with inline $\\eta$.`;

    const html = renderMarkdownWithSourceLines(md);
    expect(html).toContain("katex-display");
    expect(html).toContain("katex");
    // Ensure no broken Markdown italics inside math
    expect(html).not.toContain("<em>");
  });

  it("renders interactive question callouts with modern option cards", () => {
    const md = `> [!QUESTION] Which database should we use?
> - [x] PostgreSQL
> - [ ] SQLite`;

    const html = renderMarkdownWithSourceLines(md);
    expect(html).toContain("zen-callout-question");
    expect(html).toContain("zen-option-card");
    expect(html).toContain("PostgreSQL");
    expect(html).toContain("SQLite");
    expect(html).toContain("zen-option-custom");
  });
});
