/**
 * Markdown Source-Line AST Mapping for Marked.js
 * Injects line numbers (data-line-start, data-line-end) into rendered HTML DOM nodes
 */
import { Marked } from "marked";

export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * Calculates line ranges for all top-level block tokens in Markdown text
 */
export function extractBlockLineRanges(markdownText: string): LineRange[] {
  const marked = new Marked();
  const tokens = marked.lexer(markdownText);
  const ranges: LineRange[] = [];

  let currentLine = 1;

  for (const token of tokens) {
    if (token.type === "space") {
      const spaceLines = (token.raw.match(/\n/g) || []).length;
      currentLine += spaceLines;
      continue;
    }

    const raw = token.raw;
    const trimmed = raw.replace(/\n+$/, "");
    const innerLines = (trimmed.match(/\n/g) || []).length;

    const startLine = currentLine;
    const endLine = startLine + innerLines;

    ranges.push({ startLine, endLine });

    const totalLines = (raw.match(/\n/g) || []).length;
    currentLine += totalLines;
  }

  return ranges;
}

/**
 * Compiles Markdown to HTML with source line numbers injected into DOM tags
 */
export function renderMarkdownWithSourceLines(markdownText: string): string {
  const ranges = extractBlockLineRanges(markdownText);
  let rangeIndex = 0;

  function nextRange(): LineRange | undefined {
    return ranges[rangeIndex++];
  }

  function getAttr(range?: LineRange): string {
    if (!range) return 'class="zen-node"';
    return `data-line-start="${range.startLine}" data-line-end="${range.endLine}" class="zen-node"`;
  }

  const marked = new Marked();

  marked.use({
    renderer: {
      heading(token) {
        const range = nextRange();
        const text = this.parser.parseInline(token.tokens);
        return `<h${token.depth} ${getAttr(range)}>${text}</h${token.depth}>\n`;
      },
      paragraph(token) {
        const range = nextRange();
        const text = this.parser.parseInline(token.tokens);
        return `<p ${getAttr(range)}>${text}</p>\n`;
      },
      code(token) {
        const range = nextRange();
        const language = token.lang ? token.lang.split(/\s+/)[0] : "";
        const isMermaid = language === "mermaid";
        const isMarkmap = language === "markmap";

        if (isMermaid) {
          return `<div ${getAttr(range)} data-type="mermaid" class="zen-node zen-mermaid-container"><pre class="mermaid">${token.text}</pre><button type="button" class="zen-diagram-comment-btn" data-diagram-title="Mermaid Diagram">💬 Comment on Diagram</button></div>\n`;
        }

        if (isMarkmap) {
          return `<div ${getAttr(range)} data-type="markmap" class="zen-node zen-markmap-container"><svg class="markmap-svg"></svg><script type="text/template">${token.text}</script></div>\n`;
        }

        return `<pre ${getAttr(range)}><code class="language-${language}">${token.text}</code></pre>\n`;
      },
      blockquote(token) {
        const range = nextRange();
        const body = this.parser.parse(token.tokens);

        // Check for GFM-style [!QUESTION] or [!TIP] callouts
        const questionMatch = body.match(/^\s*<p[^>]*>\s*\[!QUESTION\]\s*([\s\S]*?)<\/p>/i);
        if (questionMatch) {
          const rest = body.replace(/^\s*<p[^>]*>\s*\[!QUESTION\]\s*[\s\S]*?<\/p>/i, "").trim();
          const questionTitle = questionMatch[1];
          const questionId = `q-${range?.startLine || Math.floor(Math.random() * 1000)}`;
          const radioBody = rest.replace(/type="checkbox"/g, `type="radio" name="${questionId}"`);
          return `<div ${getAttr(range)} class="zen-callout zen-callout-question" data-question-id="${questionId}">
            <div class="zen-callout-title">❓ ${questionTitle}</div>
            <div class="zen-callout-body">${radioBody}</div>
            <div class="zen-question-actions">
              <button type="button" class="zen-question-confirm-btn" data-question-id="${questionId}">✓ Confirm Answer</button>
            </div>
          </div>\n`;
        }

        const tipMatch = body.match(
          /^\s*<p[^>]*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*([\s\S]*?)<\/p>/i,
        );
        if (tipMatch) {
          const type = tipMatch[1].toLowerCase();
          const rest = body
            .replace(
              /^\s*<p[^>]*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*[\s\S]*?<\/p>/i,
              "",
            )
            .trim();
          return `<div ${getAttr(range)} class="zen-callout zen-callout-${type}"><div class="zen-callout-title">${tipMatch[1]}</div><div class="zen-callout-body">${rest}</div></div>\n`;
        }

        return `<blockquote ${getAttr(range)}>${body}</blockquote>\n`;
      },
      list(token) {
        const range = nextRange();
        const tag = token.ordered ? "ol" : "ul";
        const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : "";
        const body = token.items.map((item) => this.listitem(item)).join("");
        return `<${tag}${startAttr} ${getAttr(range)}>${body}</${tag}>\n`;
      },
      listitem(token) {
        if (token.task) {
          const checkedAttr = token.checked ? "checked" : "";
          const text = this.parser.parse(token.tokens);
          return `<li class="zen-task-item"><label><input type="checkbox" ${checkedAttr} class="zen-task-checkbox" /> <span>${text}</span></label></li>\n`;
        }
        const text = this.parser.parse(token.tokens);
        return `<li>${text}</li>\n`;
      },
      table(token) {
        const range = nextRange();
        let headerHtml = "<thead><tr>";
        for (const cell of token.header) {
          headerHtml += `<th>${this.parser.parseInline(cell.tokens)}</th>`;
        }
        headerHtml += "</tr></thead>";

        let bodyHtml = "<tbody>";
        for (const row of token.rows) {
          bodyHtml += "<tr>";
          for (const cell of row) {
            bodyHtml += `<td>${this.parser.parseInline(cell.tokens)}</td>`;
          }
          bodyHtml += "</tr>";
        }
        bodyHtml += "</tbody>";

        return `<div class="zen-table-wrapper" ${getAttr(range)}><table class="zen-table">${headerHtml}${bodyHtml}</table></div>\n`;
      },
      hr() {
        const range = nextRange();
        return `<hr ${getAttr(range)} />\n`;
      },
    },
  });

  return marked.parse(markdownText) as string;
}
