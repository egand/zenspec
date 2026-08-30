/**
 * Markdown Source-Line AST Mapping for Marked.js
 * Injects line numbers (data-line-start, data-line-end) into rendered HTML DOM nodes
 * Pre-renders KaTeX math formulas with zero Markdown corruption
 */
import katex from "katex";
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
 * Pre-processes Markdown to protect KaTeX formulas from Marked markdown mangling
 */
function protectAndRenderMath(markdownText: string): {
  processedText: string;
  mathReplacements: Map<string, string>;
} {
  const mathReplacements = new Map<string, string>();
  let counter = 0;

  // 1. Protect & Pre-render Display Math: $$ ... $$
  let text = markdownText.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr) => {
    const placeholder = `%%ZEN_MATH_DISPLAY_${counter++}%%`;
    let html = "";
    try {
      html = katex.renderToString(expr.trim(), {
        displayMode: true,
        throwOnError: false,
      });
    } catch {
      html = `<div class="katex-error">$$\n${expr}\n$$</div>`;
    }
    mathReplacements.set(placeholder, html);
    return placeholder;
  });

  // 2. Protect & Pre-render Inline Math: $ ... $
  text = text.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (_match, expr) => {
    const placeholder = `%%ZEN_MATH_INLINE_${counter++}%%`;
    let html = "";
    try {
      html = katex.renderToString(expr.trim(), {
        displayMode: false,
        throwOnError: false,
      });
    } catch {
      html = `<span class="katex-error">$${expr}$</span>`;
    }
    mathReplacements.set(placeholder, html);
    return placeholder;
  });

  return { processedText: text, mathReplacements };
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

  function getAttr(range?: LineRange, extraClasses = ""): string {
    const classes = extraClasses ? `zen-node ${extraClasses}` : "zen-node";
    if (!range) return `class="${classes}"`;
    return `data-line-start="${range.startLine}" data-line-end="${range.endLine}" class="${classes}"`;
  }

  const { processedText, mathReplacements } = protectAndRenderMath(markdownText);

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
          return `<div ${getAttr(range, "zen-mermaid-container")} data-type="mermaid"><pre class="mermaid">${token.text}</pre><button type="button" class="zen-diagram-comment-btn" data-diagram-title="Mermaid Diagram">💬 Comment on Diagram</button></div>\n`;
        }

        if (isMarkmap) {
          return `<div ${getAttr(range, "zen-markmap-container")} data-type="markmap"><svg class="markmap-svg"></svg><script type="text/template">${token.text}</script></div>\n`;
        }

        return `<pre ${getAttr(range)}><code class="language-${language}">${token.text}</code></pre>\n`;
      },
      blockquote(token) {
        const range = nextRange();
        const body = this.parser.parse(token.tokens);

        // Check for GFM-style [!QUESTION] callouts
        const questionMatch = body.match(/^\s*<p[^>]*>\s*\[!QUESTION\]\s*([\s\S]*?)<\/p>/i);
        if (questionMatch) {
          const rest = body.replace(/^\s*<p[^>]*>\s*\[!QUESTION\]\s*[\s\S]*?<\/p>/i, "").trim();
          const questionTitle = questionMatch[1];
          const questionId = `q-${range?.startLine || Math.floor(Math.random() * 1000)}`;

          // Transform checkboxes into clean radio option cards
          const optionRegex =
            /<li[^>]*>\s*<label[^>]*>\s*<input[^>]*?(checked)?[^>]*?>\s*<span>([\s\S]*?)<\/span>\s*<\/label>\s*<\/li>/gi;
          let optionsHtml = "";
          let match: RegExpExecArray | null;

          while ((match = optionRegex.exec(rest)) !== null) {
            const isChecked = Boolean(match[1]);
            const optionContent = match[2].replace(/<\/?p[^>]*>/g, "").trim();
            const cleanValue = optionContent.replace(/<[^>]+>/g, "").trim();

            optionsHtml += `
              <div class="zen-option-card ${isChecked ? "selected" : ""}" data-value="${cleanValue.replace(/"/g, "&quot;")}">
                <input type="radio" name="${questionId}" class="zen-option-radio" ${isChecked ? "checked" : ""} />
                <span class="zen-option-text">${optionContent}</span>
              </div>`;
          }

          if (!optionsHtml) {
            // Fallback if not matching task list format
            optionsHtml = rest;
          }

          return `<div ${getAttr(range, "zen-callout zen-callout-question")} data-question-id="${questionId}">
            <div class="zen-callout-title">❓ ${questionTitle}</div>
            <div class="zen-question-options">${optionsHtml}</div>
            <div class="zen-question-footer">
              <span class="zen-question-status" id="status-${questionId}"></span>
              <button type="button" class="zen-question-confirm-btn" data-question-id="${questionId}" data-title="${questionTitle.replace(/"/g, "&quot;")}">✓ Confirm Answer</button>
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
          return `<div ${getAttr(range, `zen-callout zen-callout-${type}`)}><div class="zen-callout-title">${tipMatch[1]}</div><div class="zen-callout-body">${rest}</div></div>\n`;
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

        return `<div ${getAttr(range, "zen-table-wrapper")}><table class="zen-table">${headerHtml}${bodyHtml}</table></div>\n`;
      },
      hr() {
        const range = nextRange();
        return `<hr ${getAttr(range)} />\n`;
      },
    },
  });

  let html = marked.parse(processedText) as string;

  // Restore pre-rendered KaTeX formulas
  for (const [placeholder, mathHtml] of mathReplacements.entries()) {
    html = html.replace(placeholder, mathHtml);
  }

  return html;
}
