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

export interface FrontmatterMetadata {
  title?: string;
  author?: string;
  date?: string;
  status?: string;
  version?: string;
  tags?: string[];
  [key: string]: any;
}

/**
 * Escapes HTML characters for safe rendering inside attributes or text
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Parses simple YAML frontmatter key-value pairs without heavy external parser
 */
export function parseFrontmatter(markdownText: string): {
  metadata: FrontmatterMetadata | null;
  body: string;
  frontmatterLines: number;
} {
  const match = markdownText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { metadata: null, body: markdownText, frontmatterLines: 0 };
  }

  const rawYaml = match[1];
  const frontmatterLines = (match[0].match(/\n/g) || []).length;
  const metadata: FrontmatterMetadata = {};

  const lines = rawYaml.split(/\r?\n/);
  let currentKey = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && currentKey) {
      const item = trimmed
        .slice(2)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!Array.isArray(metadata[currentKey])) {
        metadata[currentKey] = [];
      }
      (metadata[currentKey] as string[]).push(item);
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    currentKey = key;
    let val = line.slice(colonIdx + 1).trim();

    if (!val) {
      metadata[key] = [];
    } else if (val.startsWith("[") && val.endsWith("]")) {
      metadata[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      val = val.replace(/^["']|["']$/g, "");
      metadata[key] = val;
    }
  }

  for (const [k, v] of Object.entries(metadata)) {
    if (Array.isArray(v) && v.length === 0) {
      delete metadata[k];
    }
  }

  const body = markdownText.slice(match[0].length);
  return { metadata, body, frontmatterLines };
}

/**
 * Calculates line ranges for all top-level block tokens in Markdown text
 */
export function extractBlockLineRanges(markdownText: string, lineOffset = 0): LineRange[] {
  const marked = new Marked();
  const tokens = marked.lexer(markdownText);
  const ranges: LineRange[] = [];

  let currentLine = 1 + lineOffset;

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
      html = `<div class="katex-error">$$\n${escapeHtml(expr)}\n$$</div>`;
    }
    mathReplacements.set(placeholder, html);
    return placeholder;
  });

  // 2. Protect & Pre-render Inline Math: $ ... $ (must not be currency or whitespace-bounded)
  text = text.replace(
    /(?<![\w\\$])\$([^\s$][^$\n]*?[^\s$\\]|[^\s$\\])\$(?![\d\w])/g,
    (_match, expr) => {
      if (/^\d+(\.\d+)?$/.test(expr.trim())) {
        return _match;
      }

      const placeholder = `%%ZEN_MATH_INLINE_${counter++}%%`;
      let html = "";
      try {
        html = katex.renderToString(expr.trim(), {
          displayMode: false,
          throwOnError: false,
        });
      } catch {
        html = `<span class="katex-error">$${escapeHtml(expr)}$</span>`;
      }
      mathReplacements.set(placeholder, html);
      return placeholder;
    },
  );

  return { processedText: text, mathReplacements };
}

/**
 * Renders YAML frontmatter card if present
 */
function renderFrontmatterCard(
  meta: FrontmatterMetadata,
  startLine: number,
  endLine: number,
): string {
  let fieldsHtml = "";
  for (const [k, v] of Object.entries(meta)) {
    if (!v) continue;
    const label = k.charAt(0).toUpperCase() + k.slice(1);
    let valStr = "";
    if (Array.isArray(v)) {
      valStr = v
        .map((tag) => `<span class="zen-frontmatter-tag">${escapeHtml(tag)}</span>`)
        .join(" ");
    } else {
      valStr = `<span class="zen-frontmatter-val">${escapeHtml(String(v))}</span>`;
    }
    fieldsHtml += `<div class="zen-frontmatter-item"><span class="zen-frontmatter-key">${escapeHtml(
      label,
    )}:</span> ${valStr}</div>`;
  }

  return `<div data-line-start="${startLine}" data-line-end="${endLine}" class="zen-node zen-frontmatter-card">
    <div class="zen-frontmatter-title">📄 Document Metadata</div>
    <div class="zen-frontmatter-grid">${fieldsHtml}</div>
  </div>\n`;
}

/**
 * Compiles Markdown to HTML with source line numbers injected into DOM tags
 */
export function renderMarkdownWithSourceLines(markdownText: string): string {
  const { metadata, body, frontmatterLines } = parseFrontmatter(markdownText);
  let frontmatterHtml = "";

  if (metadata && Object.keys(metadata).length > 0) {
    frontmatterHtml = renderFrontmatterCard(metadata, 1, frontmatterLines);
  }

  const ranges = extractBlockLineRanges(body, frontmatterLines);
  let rangeIndex = 0;

  function nextRange(): LineRange | undefined {
    return ranges[rangeIndex++];
  }

  function getAttr(range?: LineRange, extraClasses = ""): string {
    const classes = extraClasses ? `zen-node ${extraClasses}` : "zen-node";
    if (!range) return `class="${classes}"`;
    return `data-line-start="${range.startLine}" data-line-end="${range.endLine}" class="${classes}"`;
  }

  const { processedText, mathReplacements } = protectAndRenderMath(body);

  const marked = new Marked();

  marked.use({
    renderer: {
      heading(token) {
        const range = nextRange();
        const text = this.parser.parseInline(token.tokens);
        const headingId = text
          .toLowerCase()
          .replace(/<[^>]+>/g, "")
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-");
        return `<h${token.depth} id="${headingId}" ${getAttr(range)}>${text}</h${token.depth}>\n`;
      },
      paragraph(token) {
        const range = nextRange();
        const text = this.parser.parseInline(token.tokens);
        return `<p ${getAttr(range)}>${text}</p>\n`;
      },
      code(token) {
        const range = nextRange();
        const rawLang = token.lang ? token.lang.split(/\s+/)[0] : "text";
        const language = rawLang.toLowerCase();
        const isMermaid = language === "mermaid";
        const isMarkmap = language === "markmap";

        if (isMermaid) {
          return `<div ${getAttr(
            range,
            "zen-mermaid-container",
          )} data-type="mermaid"><pre class="mermaid">${
            token.text
          }</pre><button type="button" class="zen-diagram-comment-btn" data-diagram-title="Mermaid Diagram">💬 Comment on Diagram</button></div>\n`;
        }

        if (isMarkmap) {
          return `<div ${getAttr(
            range,
            "zen-markmap-container",
          )} data-type="markmap"><svg class="markmap-svg"></svg><script type="text/template">${
            token.text
          }</script></div>\n`;
        }

        const escapedCode = escapeHtml(token.text);
        return `<div ${getAttr(range, "zen-code-block-wrapper")} data-lang="${language}">
          <div class="zen-code-header">
            <span class="zen-code-lang">${language}</span>
            <button type="button" class="zen-code-copy-btn" data-code="${escapedCode}">📋 Copy</button>
          </div>
          <pre class="zen-code-pre"><code class="language-${language}">${escapedCode}</code></pre>
        </div>\n`;
      },
      blockquote(token) {
        const range = nextRange();
        const bodyHtml = this.parser.parse(token.tokens);

        // Check for GFM-style [!QUESTION], [!QUESTION:MULTI], [!QUESTION:RATING], [!QUESTION:SCALE], [!QUESTION:RANK]
        const questionMatch = bodyHtml.match(
          /^\s*<p[^>]*>\s*\[!QUESTION(?::([A-Za-z0-9_-]+))?\]\s*([\s\S]*?)<\/p>/i,
        );
        if (questionMatch) {
          const qMode = (questionMatch[1] || "single").toLowerCase();
          const questionTitle = questionMatch[2];
          const questionId = `q-${range?.startLine || Math.floor(Math.random() * 1000)}`;
          const rest = bodyHtml
            .replace(/^\s*<p[^>]*>\s*\[!QUESTION(?::([A-Za-z0-9_-]+))?\]\s*[\s\S]*?<\/p>/i, "")
            .trim();

          const isMulti = qMode === "multi" || qMode === "checkbox";
          const isRating = qMode === "rating" || qMode === "scale";
          const inputType = isMulti ? "checkbox" : "radio";

          let optionsHtml = "";

          if (isRating) {
            optionsHtml += `<div class="zen-rating-group" data-rating-id="${questionId}">`;
            for (let i = 1; i <= 5; i++) {
              optionsHtml += `
                <button type="button" class="zen-rating-btn" data-value="${i}" data-question-id="${questionId}">
                  <span class="zen-rating-num">${i}</span>
                  <span class="zen-rating-stars">${"★".repeat(i)}</span>
                </button>`;
            }
            optionsHtml += `</div>`;
          } else {
            const optionRegex =
              /<li[^>]*>\s*<label[^>]*>\s*<input[^>]*?>\s*<span>([\s\S]*?)<\/span>\s*<\/label>\s*<\/li>/gi;
            let match: RegExpExecArray | null;

            while ((match = optionRegex.exec(rest)) !== null) {
              const isChecked = /\bchecked\b/i.test(match[0]);
              const optionContent = match[1].replace(/<\/?p[^>]*>/g, "").trim();
              const cleanValue = optionContent.replace(/<[^>]+>/g, "").trim();

              optionsHtml += `
                <div class="zen-option-card ${
                  isChecked ? "selected" : ""
                }" data-value="${escapeHtml(cleanValue)}" data-mode="${qMode}">
                  <input type="${inputType}" name="${questionId}" class="zen-option-input" ${
                    isChecked ? "checked" : ""
                  } />
                  <span class="zen-option-text">${optionContent}</span>
                </div>`;
            }

            // Append custom write-in option card
            optionsHtml += `
              <div class="zen-option-card zen-option-custom" data-custom="true" data-mode="${qMode}">
                <input type="${inputType}" name="${questionId}" class="zen-option-input" />
                <input type="text" class="zen-option-custom-input" placeholder="Other: Type custom answer..." />
              </div>`;
          }

          // Trailing decision notes or explanations in blockquote body
          const nonListRest = rest.replace(/<ul[^>]*>[\s\S]*?<\/ul>/gi, "").trim();
          const decisionSection = nonListRest
            ? `<div class="zen-question-decision">${nonListRest}</div>`
            : "";

          const modeBadge =
            qMode === "multi" || qMode === "checkbox"
              ? '<span class="zen-question-mode-badge">Multi-Select</span>'
              : qMode === "rating" || qMode === "scale"
                ? '<span class="zen-question-mode-badge">Rating (1-5)</span>'
                : "";

          return `<div ${getAttr(
            range,
            "zen-callout zen-callout-question",
          )} data-question-id="${questionId}" data-question-mode="${qMode}">
            <div class="zen-callout-title">❓ ${questionTitle} ${modeBadge}</div>
            <div class="zen-question-options">${optionsHtml}</div>
            ${decisionSection}
          </div>\n`;
        }

        const tipMatch = bodyHtml.match(
          /^\s*<p[^>]*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*([\s\S]*?)<\/p>/i,
        );
        if (tipMatch) {
          const type = tipMatch[1].toLowerCase();
          const firstLineContent = tipMatch[2].trim();
          let rest = bodyHtml
            .replace(
              /^\s*<p[^>]*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*[\s\S]*?<\/p>/i,
              "",
            )
            .trim();
          if (firstLineContent) {
            rest = `<p>${firstLineContent}</p>${rest ? `\n${rest}` : ""}`;
          }
          return `<div ${getAttr(
            range,
            `zen-callout zen-callout-${type}`,
          )}><div class="zen-callout-title">${
            tipMatch[1]
          }</div><div class="zen-callout-body">${rest}</div></div>\n`;
        }

        return `<blockquote ${getAttr(range)}>${bodyHtml}</blockquote>\n`;
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

        return `<div ${getAttr(
          range,
          "zen-table-wrapper",
        )}><table class="zen-table">${headerHtml}${bodyHtml}</table></div>\n`;
      },
      hr() {
        const range = nextRange();
        return `<hr ${getAttr(range)} />\n`;
      },
    },
  });

  let html = (marked.parse(processedText) as string) || "";

  // Restore pre-rendered KaTeX formulas
  for (const [placeholder, mathHtml] of mathReplacements.entries()) {
    html = html.replace(placeholder, mathHtml);
  }

  // Support GFM Footnote references: [^1]
  html = html.replace(
    /\[\^([a-zA-Z0-9_-]+)\]/g,
    '<sup class="zen-footnote-ref"><a href="#fn-$1" id="fnref-$1">[$1]</a></sup>',
  );

  return frontmatterHtml + html;
}
