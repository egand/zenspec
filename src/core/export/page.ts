/**
 * Standalone HTML export (plan §8.2): the document plus its review trail (decisions, threads
 * with their resolutions, and the revision/review history), in one file with inlined CSS.
 * Pure: the CLI fetches the state and writes the file.
 */
import type { Root } from "mdast";
import { decisionRecords, documentTitle, type DecisionRecord } from "../decisions.js";
import { parseDocument } from "../parse.js";
import { threadList } from "../reducer.js";
import type {
  DocState,
  DocumentRef,
  Message,
  ParsedMarkdown,
  Question,
  Thread,
  ThreadStatus,
} from "../types.js";
import { escapeHtml } from "../html.js";
import { collectDefinitions, MarkdownHtml } from "./markdown.js";
import { EXPORT_CSS } from "./styles.js";

export interface ExportInput {
  doc: Pick<DocumentRef, "relPath" | "kind">;
  /** The document's content (Markdown or HTML). */
  content: string;
  state: DocState;
  /** ISO timestamp shown in the header. */
  exportedAt: string;
  /** zenspec version shown in the header. */
  version?: string;
}

/** Mermaid is the only thing loaded from the network; everything else is inline. */
export const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

export function renderExport(input: ExportInput): string {
  const { doc, content, state } = input;
  const parsed = doc.kind === "markdown" ? parseDocument(content) : undefined;
  const title = parsed ? documentTitle(parsed, doc.relPath) : doc.relPath;
  const records = parsed ? decisionRecords(state, parsed) : [];
  const body = parsed
    ? renderMarkdownDocument(parsed, records)
    : `<iframe class="zen-mockup" sandbox title="${escapeHtml(doc.relPath)}" srcdoc="${escapeHtml(content)}"></iframe>`;
  const mermaid = body.includes('<pre class="mermaid">');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="zenspec${input.version ? ` ${escapeHtml(input.version)}` : ""}">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<div class="zen-export">
${renderMeta(input)}
<main class="zen-document">
${body}
</main>
${renderTrail(state, records)}
</div>
${mermaid ? mermaidScript() : ""}</body>
</html>
`;
}

function renderMeta({ doc, state, exportedAt, version }: ExportInput): string {
  const revision = state.revisions.at(-1);
  const parts = [
    `<code>${escapeHtml(doc.relPath)}</code>`,
    badge(state.phase),
    revision ? `revision ${revision.n}` : "unpublished",
    `exported ${escapeHtml(exportedAt.slice(0, 10))}${version ? ` by zenspec ${escapeHtml(version)}` : ""}`,
  ];
  return `<header class="zen-export-meta">${parts.join(" · ")}</header>`;
}

function renderMarkdownDocument(parsed: ParsedMarkdown, records: DecisionRecord[]): string {
  const root: Root = { type: "root", children: parsed.blocks.map((b) => b.node) };
  const html = new MarkdownHtml(collectDefinitions(root));
  const questions = new Map(parsed.questions.map((q) => [q.block, q]));
  return parsed.blocks
    .map((block) => {
      if (block.node.type === "yaml") return "";
      const question = questions.get(block.id);
      if (question) {
        return renderQuestion(
          question,
          records.find((r) => r.question === question),
        );
      }
      return html.render(block.node, block.node.type === "heading" ? block.id : undefined);
    })
    .filter(Boolean)
    .join("\n");
}

function renderQuestion(q: Question, record: DecisionRecord | undefined): string {
  const options = q.options
    .map((option) => {
      const chosen = record?.chosen.includes(option);
      const tags = [chosen && "chosen", q.recommended === option && "recommended"].filter(Boolean);
      const tag = tags.length ? ` <span class="zen-option-tag">(${tags.join(", ")})</span>` : "";
      return `<li${chosen ? ' class="zen-option-chosen"' : ""}>${escapeHtml(option)}${tag}</li>`;
    })
    .join("");
  const answer = record
    ? `<p class="zen-question-answer"><strong>Decision:</strong> ${escapeHtml(record.outcome)}${record.note ? ` · ${escapeHtml(record.note)}` : ""}</p>`
    : `<p class="zen-question-answer zen-muted">Not answered.</p>`;
  return (
    `<div class="zen-question" id="question-${escapeHtml(q.id)}">` +
    `<div class="zen-question-label">Question${q.mode === "single" ? "" : ` · ${q.mode}`}</div>` +
    `<div class="zen-question-title">${escapeHtml(q.title)}</div>` +
    (options ? `<ul>${options}</ul>` : "") +
    `${answer}</div>`
  );
}

function renderTrail(state: DocState, records: DecisionRecord[]): string {
  const threads = threadList(state);
  const resolved = threads.filter((t) => t.status === "resolved").length;
  return `<section class="zen-trail" id="review-trail">
<h2>Review trail</h2>
<h3 id="decisions">Decisions</h3>
${records.length ? records.map(renderDecision).join("\n") : `<p class="zen-muted">No decisions recorded.</p>`}
<h3 id="threads">Threads</h3>
${threads.length ? `<p class="zen-muted">${threads.length} threads, ${resolved} resolved.</p>\n${threads.map(renderThread).join("\n")}` : `<p class="zen-muted">No threads.</p>`}
<h3 id="history">History</h3>
${renderHistory(state)}
</section>`;
}

function renderDecision(r: DecisionRecord): string {
  const note = r.note ? `<p class="zen-message-body">${escapeHtml(r.note)}</p>` : "";
  return (
    `<div class="zen-decision"><div class="zen-thread-head"><strong>${escapeHtml(r.title)}</strong>` +
    `${badge(r.thread.status)}<a href="#thread-${escapeHtml(r.thread.id)}">${escapeHtml(r.thread.id)}</a></div>` +
    `<p>Chosen: <strong>${escapeHtml(r.outcome)}</strong>${r.thread.choice.mode === "other" ? " (written in)" : ""}</p>${note}</div>`
  );
}

function renderThread(t: Thread): string {
  const lines =
    "anchor" in t && t.anchor.type === "markdown"
      ? (t.placement?.lines ?? t.anchor.lines)
      : undefined;
  const at = lines ? (lines[0] === lines[1] ? `L${lines[0]}` : `L${lines[0]}-${lines[1]}`) : "";
  const head =
    `<div class="zen-thread-head"><strong>${escapeHtml(t.id)}</strong>` +
    `<span class="zen-badge">${t.kind}</span>${badge(t.status)}` +
    `${at ? `<span class="zen-muted">${at}</span>` : ""}</div>`;
  return `<article class="zen-thread" id="thread-${escapeHtml(t.id)}">${head}${threadSubject(t)}<ol class="zen-messages">${t.messages.map(renderMessage).join("")}</ol></article>`;
}

function threadSubject(t: Thread): string {
  switch (t.kind) {
    case "suggestion":
      return `<p class="zen-suggestion"><del>${escapeHtml(t.old)}</del> → <ins>${escapeHtml(t.new)}</ins></p>`;
    case "decision":
      return `<p>Question <code>${escapeHtml(t.question)}</code></p>`;
    case "explain":
      return `<p>Explain <strong>${escapeHtml(t.term)}</strong></p>`;
    case "comment": {
      const quote = t.anchor.type === "markdown" ? t.anchor.quote : t.anchor.textQuote;
      return quote ? `<blockquote class="zen-thread-quote">${escapeHtml(quote)}</blockquote>` : "";
    }
    default:
      return "";
  }
}

function renderMessage(m: Message): string {
  const where = m.revision ? ` · revision ${m.revision}` : m.review ? ` · review ${m.review}` : "";
  const images = m.attachments.length
    ? ` · ${m.attachments.length} image${m.attachments.length === 1 ? "" : "s"} (not exported)`
    : "";
  const body = m.body.trim() ? `<div class="zen-message-body">${escapeHtml(m.body)}</div>` : "";
  return `<li><div class="zen-message-head">${escapeHtml(m.author)} · ${m.action}${where} · ${escapeHtml(m.ts.slice(0, 10))}${images}</div>${body}</li>`;
}

function renderHistory(state: DocState): string {
  const items = [
    ...state.revisions.map((r) => ({
      ts: r.ts,
      html: `Revision ${r.n} published${r.summary ? `: ${escapeHtml(r.summary)}` : ""}`,
    })),
    ...state.reviews.map((r) => ({
      ts: r.ts,
      html: `Review ${r.n} on revision ${r.revision} ${badge(r.verdict)}${r.summary ? ` ${escapeHtml(r.summary)}` : ""}`,
    })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));
  if (!items.length) return `<p class="zen-muted">Nothing published yet.</p>`;
  const li = items.map(
    (i) => `<li><span class="zen-muted">${escapeHtml(i.ts.slice(0, 10))}</span> ${i.html}</li>`,
  );
  return `<ol class="zen-history">${li.join("")}</ol>`;
}

function badge(value: ThreadStatus | string): string {
  return `<span class="zen-badge zen-badge-${escapeHtml(value)}">${escapeHtml(value.replace(/_/g, " "))}</span>`;
}

function mermaidScript(): string {
  return `<!-- Mermaid diagrams render in the browser from ${MERMAID_CDN} (needs network access); offline they stay as source. -->
<script type="module">
import mermaid from "${MERMAID_CDN}";
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: true, theme: dark ? "dark" : "default", securityLevel: "strict" });
</script>
`;
}
