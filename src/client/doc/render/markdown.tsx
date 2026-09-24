/**
 * mdast → Preact renderer. Raw HTML inside Markdown is shown as text, never injected; only
 * KaTeX and Mermaid output (generated locally, not from the Markdown's own HTML) uses innerHTML.
 *
 * Inner elements that need to be highlighted separately (list items, table rows, code lines)
 * carry `data-rl-start`/`data-rl-end`: lines relative to the block's first line. Relative lines
 * stay correct when the block moves, so a memoized block never has to re-render just because
 * text above it gained a line.
 */
import type { ComponentChildren, JSX } from "preact";
import type { Blockquote, List, ListItem, Nodes, Paragraph, PhrasingContent, Table } from "mdast";
import type { KbTerm } from "../types.js";
import { KbTermMark } from "../kb/KbTermMark.js";
import { termPattern } from "../kb/terms.js";
import { MermaidDiagram } from "../mermaid/MermaidDiagram.js";
import { CodeBlock } from "./CodeBlock.js";
import { MathView } from "./MathView.js";
import { safeUrl } from "../../../core/html.js";

export interface BlockStep {
  id: string;
  checked: boolean;
  checkedAt?: string;
  /** First unchecked step of the document (§10: the current step is highlighted). */
  current: boolean;
}

export interface Definitions {
  [identifier: string]: { url: string; title?: string | null };
}

export interface RenderCtx {
  blockId: string;
  startLine: number;
  terms: KbTerm[];
  /** Terms already underlined during this render. */
  claimed: Set<string>;
  steps: BlockStep[];
  nextStep: number;
  definitions: Definitions;
  inLink: boolean;
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

function relLines(node: Nodes, ctx: RenderCtx): Record<string, number> {
  if (!node.position) return {};
  return {
    "data-rl-start": node.position.start.line - ctx.startLine,
    "data-rl-end": node.position.end.line - ctx.startLine,
  };
}

function children(nodes: readonly Nodes[], ctx: RenderCtx): ComponentChildren[] {
  return nodes.map((node, i) => renderNode(node, ctx, i));
}

function renderText(value: string, ctx: RenderCtx): ComponentChildren {
  const open = ctx.inLink ? [] : ctx.terms.filter((t) => !ctx.claimed.has(t.term));
  if (!open.length) return value;
  const parts: ComponentChildren[] = [];
  let rest = value;
  for (;;) {
    let best: { term: KbTerm; index: number; text: string } | undefined;
    for (const term of open) {
      if (ctx.claimed.has(term.term)) continue;
      const m = termPattern(term).exec(rest);
      if (m && (!best || m.index < best.index)) best = { term, index: m.index, text: m[0] };
    }
    if (!best) break;
    ctx.claimed.add(best.term.term);
    parts.push(rest.slice(0, best.index));
    parts.push(<KbTermMark key={best.term.term} term={best.term} text={best.text} />);
    rest = rest.slice(best.index + best.text.length);
  }
  parts.push(rest);
  return parts;
}

function renderListItem(item: ListItem, loose: boolean, ctx: RenderCtx, key: number) {
  const step = typeof item.checked === "boolean" ? ctx.steps[ctx.nextStep++] : undefined;
  const body = item.children.map((child, i) =>
    !loose && child.type === "paragraph"
      ? children(child.children, ctx)
      : renderNode(child, ctx, i),
  );
  if (typeof item.checked !== "boolean") {
    return (
      <li key={key} {...relLines(item, ctx)}>
        {body}
      </li>
    );
  }
  const checked = step?.checked ?? item.checked;
  const title = checked
    ? step?.checkedAt
      ? `Checked ${new Date(step.checkedAt).toLocaleString()}`
      : "Checked"
    : "Not done yet: the agent ticks this step in the file";
  const cls = ["zen-task", checked && "zen-task-done", step?.current && "zen-step-current"];
  return (
    <li
      key={key}
      class={cls.filter(Boolean).join(" ")}
      data-step-id={step?.id}
      {...relLines(item, ctx)}
    >
      <input
        type="checkbox"
        class="zen-task-box"
        checked={checked}
        disabled
        readOnly
        title={title}
      />
      {body}
    </li>
  );
}

function renderList(list: List, ctx: RenderCtx, key: number) {
  const loose = !!list.spread || list.children.some((item) => item.spread);
  const items = list.children.map((item, i) => renderListItem(item, loose, ctx, i));
  const task = list.children.some((item) => typeof item.checked === "boolean");
  const cls = task ? "zen-task-list" : undefined;
  return list.ordered ? (
    <ol key={key} class={cls} start={list.start ?? undefined}>
      {items}
    </ol>
  ) : (
    <ul key={key} class={cls}>
      {items}
    </ul>
  );
}

function renderTable(table: Table, ctx: RenderCtx, key: number) {
  const align = (i: number) => table.align?.[i] ?? undefined;
  const [head, ...rows] = table.children;
  const row = (r: (typeof table.children)[number], i: number, Cell: "th" | "td") => (
    <tr key={i} {...relLines(r, ctx)}>
      {r.children.map((cell, j) => (
        <Cell key={j} style={align(j) ? { textAlign: align(j)! } : undefined}>
          {children(cell.children, ctx)}
        </Cell>
      ))}
    </tr>
  );
  return (
    <div key={key} class="zen-table-wrapper">
      <table class="zen-table">
        {head && <thead>{row(head, 0, "th")}</thead>}
        <tbody>{rows.map((r, i) => row(r, i + 1, "td"))}</tbody>
      </table>
    </div>
  );
}

function renderBlockquote(node: Blockquote, ctx: RenderCtx, key: number) {
  const [head, ...rest] = node.children;
  const first = head?.type === "paragraph" ? head.children[0] : undefined;
  const alert = first?.type === "text" ? ALERT.exec(first.value) : null;
  if (!alert || head?.type !== "paragraph" || first?.type !== "text") {
    return <blockquote key={key}>{children(node.children, ctx)}</blockquote>;
  }
  const kind = alert[1]!.toLowerCase();
  const stripped: Paragraph = {
    ...head,
    children: [{ ...first, value: first.value.slice(alert[0].length) }, ...head.children.slice(1)],
  };
  const hasText = stripped.children.some((c) => c.type !== "text" || c.value.trim());
  return (
    <div key={key} class={`zen-callout zen-callout-${kind}`}>
      <div class="zen-callout-title">{kind[0]!.toUpperCase() + kind.slice(1)}</div>
      {hasText && renderNode(stripped, ctx, 0)}
      {children(rest, ctx)}
    </div>
  );
}

function renderLink(
  node: { children: PhrasingContent[]; url: string; title?: string | null },
  ctx: RenderCtx,
  key: number,
) {
  const inLink = ctx.inLink;
  ctx.inLink = true;
  const content = children(node.children, ctx);
  ctx.inLink = inLink;
  const href = safeUrl(node.url);
  const external = href && /^https?:/i.test(href);
  return (
    <a
      key={key}
      href={href}
      title={node.title ?? undefined}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
    >
      {content}
    </a>
  );
}

export function renderNode(node: Nodes, ctx: RenderCtx, key = 0): ComponentChildren {
  switch (node.type) {
    case "root":
      return children(node.children, ctx);
    case "paragraph":
      return <p key={key}>{children(node.children, ctx)}</p>;
    case "heading": {
      const Tag = `h${node.depth}` as keyof JSX.IntrinsicElements;
      return (
        <Tag key={key} id={`zen-h-${ctx.blockId}`}>
          {children(node.children, ctx)}
        </Tag>
      );
    }
    case "thematicBreak":
      return <hr key={key} />;
    case "blockquote":
      return renderBlockquote(node, ctx, key);
    case "list":
      return renderList(node, ctx, key);
    case "listItem":
      return renderListItem(node, true, ctx, key);
    case "table":
      return renderTable(node, ctx, key);
    case "code": {
      if (node.lang === "mermaid") return <MermaidDiagram key={key} code={node.value} />;
      // A fenced block spans more source lines than its value: skip the opening fence.
      const pos = node.position;
      const span = pos ? pos.end.line - pos.start.line + 1 : 0;
      const fence = span > node.value.split("\n").length ? 1 : 0;
      const firstLine = (pos ? pos.start.line - ctx.startLine : 0) + fence;
      return (
        <CodeBlock key={key} lang={node.lang ?? ""} value={node.value} firstLine={firstLine} />
      );
    }
    case "math":
      return <MathView key={key} value={node.value} display />;
    case "inlineMath":
      return <MathView key={key} value={node.value} display={false} />;
    case "html":
      return /^<br\s*\/?>$/i.test(node.value.trim()) ? (
        <br key={key} />
      ) : (
        <code key={key} class="zen-raw-html">
          {node.value}
        </code>
      );
    case "text":
      return renderText(node.value, ctx);
    case "emphasis":
      return <em key={key}>{children(node.children, ctx)}</em>;
    case "strong":
      return <strong key={key}>{children(node.children, ctx)}</strong>;
    case "delete":
      return <del key={key}>{children(node.children, ctx)}</del>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "break":
      return <br key={key} />;
    case "link":
      return renderLink(node, ctx, key);
    case "linkReference": {
      const def = ctx.definitions[node.identifier];
      return def
        ? renderLink({ ...def, children: node.children }, ctx, key)
        : children(node.children, ctx);
    }
    case "image":
      return (
        <img
          key={key}
          src={safeUrl(node.url)}
          alt={node.alt ?? ""}
          title={node.title ?? undefined}
          loading="lazy"
        />
      );
    case "imageReference": {
      const def = ctx.definitions[node.identifier];
      return def ? (
        <img key={key} src={safeUrl(def.url)} alt={node.alt ?? ""} loading="lazy" />
      ) : (
        node.alt
      );
    }
    case "footnoteReference":
      return (
        <sup key={key} class="zen-footnote-ref">
          <a href={`#zen-fn-${node.identifier}`}>{node.label ?? node.identifier}</a>
        </sup>
      );
    case "footnoteDefinition":
      return (
        <div key={key} class="zen-footnote" id={`zen-fn-${node.identifier}`}>
          <sup>{node.label ?? node.identifier}</sup> {children(node.children, ctx)}
        </div>
      );
    case "definition":
    case "yaml":
      return null;
    default:
      return null;
  }
}
