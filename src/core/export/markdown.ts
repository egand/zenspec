/**
 * mdast → HTML string for the standalone export. Follows the doc view's rendering rules
 * (`src/client/doc/render/markdown.tsx`) without Preact: raw HTML in the Markdown is shown as
 * text, unsafe URLs are dropped, GitHub alerts become callouts, task items are read-only
 * checkboxes, Mermaid stays as source for the page script, and math is rendered by KaTeX as
 * MathML (no stylesheet or fonts needed).
 */
import katex from "katex";
import { escapeHtml, safeUrl } from "../html.js";
import type { Blockquote, List, ListItem, Nodes, Paragraph, PhrasingContent, Table } from "mdast";

export interface Definitions {
  [identifier: string]: { url: string; title?: string | null };
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

const attr = (name: string, value: string | null | undefined): string =>
  value === undefined || value === null ? "" : ` ${name}="${escapeHtml(value)}"`;

export function renderMath(value: string, display: boolean): string {
  const html = katex.renderToString(value, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    output: "mathml",
  });
  return display ? `<div class="zen-math">${html}</div>` : html;
}

/** All definitions (`[id]: url`) in a tree, for reference-style links and images. */
export function collectDefinitions(node: Nodes, into: Definitions = {}): Definitions {
  if (node.type === "definition") into[node.identifier] = { url: node.url, title: node.title };
  if ("children" in node) for (const child of node.children) collectDefinitions(child, into);
  return into;
}

export class MarkdownHtml {
  constructor(private readonly definitions: Definitions = {}) {}

  /** `headingId` sets the `id` of a top-level heading (block ids make stable anchors). */
  render(node: Nodes, headingId?: string): string {
    switch (node.type) {
      case "root":
        return this.children(node.children);
      case "paragraph":
        return `<p>${this.children(node.children)}</p>`;
      case "heading":
        return `<h${node.depth}${attr("id", headingId)}>${this.children(node.children)}</h${node.depth}>`;
      case "thematicBreak":
        return "<hr>";
      case "blockquote":
        return this.blockquote(node);
      case "list":
        return this.list(node);
      case "listItem":
        return this.listItem(node, true);
      case "table":
        return this.table(node);
      case "code":
        if (node.lang === "mermaid") return `<pre class="mermaid">${escapeHtml(node.value)}</pre>`;
        return (
          `<div class="zen-code">${node.lang ? `<span class="zen-code-lang">${escapeHtml(node.lang)}</span>` : ""}` +
          `<pre><code${attr("class", node.lang ? `language-${node.lang}` : undefined)}>${escapeHtml(node.value)}</code></pre></div>`
        );
      case "math":
        return renderMath(node.value, true);
      case "inlineMath":
        return renderMath(node.value, false);
      case "html":
        return /^<br\s*\/?>$/i.test(node.value.trim())
          ? "<br>"
          : `<code class="zen-raw-html">${escapeHtml(node.value)}</code>`;
      case "text":
        return escapeHtml(node.value);
      case "emphasis":
        return `<em>${this.children(node.children)}</em>`;
      case "strong":
        return `<strong>${this.children(node.children)}</strong>`;
      case "delete":
        return `<del>${this.children(node.children)}</del>`;
      case "inlineCode":
        return `<code>${escapeHtml(node.value)}</code>`;
      case "break":
        return "<br>";
      case "link":
        return this.link(node);
      case "linkReference": {
        const def = this.definitions[node.identifier];
        return def ? this.link({ ...def, children: node.children }) : this.children(node.children);
      }
      case "image":
        return this.image(node.url, node.alt, node.title);
      case "imageReference": {
        const def = this.definitions[node.identifier];
        return def ? this.image(def.url, node.alt, def.title) : escapeHtml(node.alt ?? "");
      }
      case "footnoteReference":
        return `<sup class="zen-footnote-ref"><a href="#zen-fn-${escapeHtml(node.identifier)}">${escapeHtml(node.label ?? node.identifier)}</a></sup>`;
      case "footnoteDefinition":
        return `<div class="zen-footnote" id="zen-fn-${escapeHtml(node.identifier)}"><sup>${escapeHtml(node.label ?? node.identifier)}</sup> ${this.children(node.children)}</div>`;
      default:
        return "";
    }
  }

  private children(nodes: readonly Nodes[]): string {
    return nodes.map((node) => this.render(node)).join("");
  }

  private blockquote(node: Blockquote): string {
    const [head, ...rest] = node.children;
    const first = head?.type === "paragraph" ? head.children[0] : undefined;
    const alert = first?.type === "text" ? ALERT.exec(first.value) : null;
    if (!alert || head?.type !== "paragraph" || first?.type !== "text") {
      return `<blockquote>${this.children(node.children)}</blockquote>`;
    }
    const kind = alert[1]!.toLowerCase();
    const stripped: Paragraph = {
      ...head,
      children: [
        { ...first, value: first.value.slice(alert[0].length) },
        ...head.children.slice(1),
      ],
    };
    const hasText = stripped.children.some((c) => c.type !== "text" || c.value.trim());
    const title = kind[0]!.toUpperCase() + kind.slice(1);
    return (
      `<div class="zen-callout zen-callout-${kind}"><div class="zen-callout-title">${title}</div>` +
      `${hasText ? this.render(stripped) : ""}${this.children(rest)}</div>`
    );
  }

  private list(list: List): string {
    const loose = !!list.spread || list.children.some((item) => item.spread);
    const items = list.children.map((item) => this.listItem(item, loose)).join("");
    const task = list.children.some((item) => typeof item.checked === "boolean");
    const cls = attr("class", task ? "zen-task-list" : undefined);
    if (!list.ordered) return `<ul${cls}>${items}</ul>`;
    const start = list.start !== null && list.start !== undefined && list.start !== 1;
    return `<ol${cls}${start ? attr("start", String(list.start)) : ""}>${items}</ol>`;
  }

  private listItem(item: ListItem, loose: boolean): string {
    const body = item.children
      .map((child) =>
        !loose && child.type === "paragraph" ? this.children(child.children) : this.render(child),
      )
      .join("");
    if (typeof item.checked !== "boolean") return `<li>${body}</li>`;
    const checked = item.checked ? " checked" : "";
    const cls = item.checked ? "zen-task zen-task-done" : "zen-task";
    return `<li class="${cls}"><input type="checkbox" disabled${checked}> ${body}</li>`;
  }

  private table(table: Table): string {
    const [head, ...rows] = table.children;
    const row = (r: (typeof table.children)[number], cell: "th" | "td") =>
      `<tr>${r.children
        .map((c, i) => {
          const align = table.align?.[i];
          return `<${cell}${attr("style", align ? `text-align:${align}` : undefined)}>${this.children(c.children)}</${cell}>`;
        })
        .join("")}</tr>`;
    return (
      `<div class="zen-table-wrapper"><table>` +
      (head ? `<thead>${row(head, "th")}</thead>` : "") +
      `<tbody>${rows.map((r) => row(r, "td")).join("")}</tbody></table></div>`
    );
  }

  private link(node: { children: PhrasingContent[]; url: string; title?: string | null }): string {
    const href = safeUrl(node.url);
    const external = href && /^https?:/i.test(href);
    return (
      `<a${attr("href", href)}${attr("title", node.title)}` +
      `${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${this.children(node.children)}</a>`
    );
  }

  private image(url: string, alt: string | null | undefined, title?: string | null): string {
    return `<img${attr("src", safeUrl(url))}${attr("alt", alt ?? "")}${attr("title", title)} loading="lazy">`;
  }
}
