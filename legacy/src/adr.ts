import fs from "node:fs";
import path from "node:path";
import { SessionState, ActorRole } from "./types.js";

export interface ParsedQuestionDecision {
  title: string;
  mode: string;
  selectedOption: string;
  allOptions: string[];
  decisionNote?: string;
  line: number;
}

/**
 * Resolves the destination path for an ADR, creating the ../adr directory if needed
 */
export function resolveDefaultAdrPath(filePath: string, customOut?: string): string {
  if (customOut) return customOut;
  const canonical = fs.existsSync(filePath) ? fs.realpathSync(filePath) : path.resolve(filePath);
  const adrDir = path.join(path.dirname(canonical), "../adr");
  if (!fs.existsSync(adrDir)) {
    fs.mkdirSync(adrDir, { recursive: true });
  }
  const base = path.basename(canonical, path.extname(canonical));
  return path.join(adrDir, `0001-${base}.md`);
}

/**
 * Parses answered questions and decisions from Markdown text
 */
export function extractDecisionsFromMarkdown(markdownText: string): ParsedQuestionDecision[] {
  const decisions: ParsedQuestionDecision[] = [];
  const questionRegex =
    />\s*\[!(QUESTION|DECISION)(?::([A-Za-z0-9_-]+))?\]\s*([^\n]+)([\s\S]*?)(?=(?:>\s*\[!(?:QUESTION|DECISION)|\n#{1,6}\s|$))/gi;

  let match: RegExpExecArray | null;
  while ((match = questionRegex.exec(markdownText)) !== null) {
    const kind = match[1].toUpperCase();
    const mode = (match[2] || (kind === "DECISION" ? "decision" : "single")).toLowerCase();
    const title = match[3].trim();
    const body = match[4];

    // Find line number
    const upToMatch = markdownText.slice(0, match.index);
    const line = (upToMatch.match(/\n/g) || []).length + 1;

    const options: string[] = [];
    let selectedOption = "";

    const optionRegex = />\s*-\s*\[([ xX])\]\s*([^\n]+)/g;
    let optMatch: RegExpExecArray | null;
    while ((optMatch = optionRegex.exec(body)) !== null) {
      const isChecked = optMatch[1].toLowerCase() === "x";
      const optText = optMatch[2].trim();
      options.push(optText);
      if (isChecked && !selectedOption) {
        selectedOption = optText;
      }
    }

    const decisionNoteMatch = body.match(
      />\s*(?:\*\*Decision\*\*|Decision:|\bWe decide to\b)\s*([^\n]+)/i,
    );
    const decisionNote = decisionNoteMatch ? decisionNoteMatch[1].trim() : undefined;

    if (!selectedOption && body.trim()) {
      const firstLine = body.replace(/^>\s*/gm, "").trim().split("\n")[0];
      if (firstLine) selectedOption = firstLine;
    }

    decisions.push({
      title,
      mode,
      selectedOption: selectedOption || (options[0] ?? "Accepted"),
      allOptions: options.length > 0 ? options : [selectedOption || "Accepted"],
      decisionNote,
      line,
    });
  }

  return decisions;
}

/**
 * Generates standard Architecture Decision Record (ADR) Markdown document
 */
export function generateADRDocument(options: {
  session: SessionState;
  docContent: string;
  adrNumber?: number;
  author?: string;
}): string {
  const { session, docContent, adrNumber = 1, author = "AI Agent & Human Reviewer" } = options;
  const decisions = extractDecisionsFromMarkdown(docContent);

  const titleMatch = docContent.match(/^#\s+(.+)$/m);
  const docTitle = titleMatch ? titleMatch[1].trim() : "Architecture Decision";

  const numStr = String(adrNumber).padStart(4, "0");
  const dateStr = new Date().toISOString().split("T")[0];

  let decisionsSection = "";
  if (decisions.length > 0) {
    for (const d of decisions) {
      decisionsSection += `### ${d.title}\n\n`;
      decisionsSection += `* **Chosen Outcome**: \`${d.selectedOption}\`\n`;
      if (d.decisionNote) {
        decisionsSection += `* **Rationale**: ${d.decisionNote}\n`;
      }
      decisionsSection += `* **Considered Options**:\n`;
      for (const opt of d.allOptions) {
        const marker = opt === d.selectedOption ? "[x] **Selected** -" : "[ ]";
        decisionsSection += `  - ${marker} ${opt}\n`;
      }
      decisionsSection += "\n";
    }
  } else {
    decisionsSection = `* **Primary Decision**: Adopted architecture specification as documented in [${session.filePath}](${session.filePath}).\n`;
  }

  let chatTranscriptSection = "";
  if (session.chatHistory && session.chatHistory.length > 0) {
    chatTranscriptSection = `## Review & Dialogue Transcript\n\n`;
    for (const msg of session.chatHistory) {
      const senderBadge = msg.sender === ActorRole.Agent ? "🤖 Agent" : "👤 Reviewer";
      chatTranscriptSection += `> **${senderBadge}** (${msg.createdAt.slice(11, 19)}):\n> ${msg.text.replace(/\n/g, "\n> ")}\n\n`;
    }
  }

  const statusText = session.approved
    ? `Accepted (Approved${session.approvedAt ? ` on ${session.approvedAt.slice(0, 10)}` : ""})`
    : session.ended
      ? "Concluded (Pending Approval)"
      : "Draft / In Review";

  return `# ADR-${numStr}: ${docTitle}

* **Status**: ${statusText}
* **Date**: ${dateStr}
* **Authors**: ${author}
* **Source Document**: \`${session.filePath}\`

## Context and Problem Statement

This decision record formalizes the architectural specifications, component tradeoffs, and design choices established during the interactive review of \`${session.filePath}\`.

## Decision Drivers

* Maintain minimalist, token-efficient architecture
* Ensure high developer ergonomics, testability, and deterministic reproducibility
* Balance operational simplicity with long-term extensibility

## Considered Options & Decisions

${decisionsSection}
## Consequences

### Positive
* Clear consensus between reviewer and agent on core structural components.
* Deterministic line-anchored specifications with zero ambiguous requirements.
* Full audit trail linking ADR decisions to codebase implementation.

### Negative / Tradeoffs
* Requires disciplined adherence to ADR standards across future refactors.

${chatTranscriptSection}
---
*Generated by ZenSpec (Agent Experience Interface) at ${new Date().toISOString()}*
`;
}
