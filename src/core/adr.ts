/**
 * MADR-style Architecture Decision Record from a document's decision threads (plan §8.2).
 * Pure: the CLI fetches the state and writes the file.
 */
import { decisionDate, decisionRecords, documentTitle, type DecisionRecord } from "./decisions.js";
import { slugify } from "./parse.js";
import { gateStatus } from "./reducer.js";
import type { DocState, Message, ParsedDocument } from "./types.js";

export interface AdrInput {
  /** Repo-relative path of the reviewed document. */
  relPath: string;
  state: DocState;
  /** The document parsed with `parseDocument` (question titles and options). */
  doc: ParsedDocument;
}

/** The ADR as Markdown, or `undefined` when the document has no decision threads. */
export function renderAdr({ relPath, state, doc }: AdrInput): string | undefined {
  const records = decisionRecords(state, doc);
  if (records.length === 0) return undefined;
  const gate = gateStatus(state);
  const date = decisionDate(state);
  const context = gate.approvedRevision
    ? `approved at revision ${gate.approvedRevision}${date ? ` on ${date}` : ""}`
    : "not approved yet";

  const lines = [
    "---",
    `status: ${gate.approved ? "accepted" : "proposed"}`,
    ...(date ? [`date: ${date}`] : []),
    "decision-makers: reviewer, agent",
    "---",
    "",
    `# ${documentTitle(doc, relPath)}`,
    "",
    "## Context and Problem Statement",
    "",
    `These decisions were made while reviewing [${relPath}](/${relPath}) with ZenSpec (${context}). ` +
      "The document holds the full context.",
    "",
    "## Decisions",
    ...records.flatMap(renderDecision),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderDecision(record: DecisionRecord): string[] {
  const lines = ["", `### ${oneLine(record.title)}`, ""];
  if (record.options.length > 0) {
    lines.push("#### Considered Options", "");
    for (const option of record.options) {
      const tags = [
        record.chosen.includes(option) && "chosen",
        record.question?.recommended === option && "recommended",
      ].filter(Boolean);
      lines.push(`* ${option}${tags.length ? ` (${tags.join(", ")})` : ""}`);
    }
    lines.push("");
  }
  lines.push("#### Decision Outcome", "");
  const note = record.note;
  const outcome = `Chosen option: "${oneLine(record.outcome)}"`;
  if (!note) lines.push(`${outcome}.`);
  else if (!note.includes("\n")) lines.push(`${outcome}, because ${note}`);
  else lines.push(`${outcome}, because:`, "", quote(note));
  if (record.thread.choice.mode === "other") lines.push("", "Written in by the reviewer.");

  const discussion = record.discussion.filter((m) => m.body.trim() || m.action === "resolved");
  if (discussion.length > 0) {
    lines.push("", "#### Discussion", "");
    for (const message of discussion) lines.push(renderMessage(message));
  }
  return lines;
}

function renderMessage(m: Message): string {
  const where = m.revision ? `, revision ${m.revision}` : m.review ? `, review ${m.review}` : "";
  const head = `* **${m.author}** (${m.action}${where}, ${m.ts.slice(0, 10)})`;
  const body = m.body.trim();
  if (!body) return head;
  return `${head}: ${body.replace(/\n/g, "\n  ")}`;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

/** One past the highest `NNNN-` prefix among existing ADR file names (1 when there are none). */
export function nextAdrNumber(existing: readonly string[]): number {
  let max = 0;
  for (const name of existing) {
    const match = /^(\d+)-.*\.md$/.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** `0003-which-database-engine.md`; the slug is capped at 60 characters on a word boundary. */
export function adrFileName(number: number, title: string): string {
  let slug = slugify(title, "decision");
  if (slug.length > 60) {
    const cut = slug.slice(0, 60);
    slug = cut.lastIndexOf("-") > 0 ? cut.slice(0, cut.lastIndexOf("-")) : cut;
  }
  return `${String(number).padStart(4, "0")}-${slug}.md`;
}
