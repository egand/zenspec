/** A reviewed plan with decisions, comments and a suggestion, as an event log (ADR and export tests). */
import { EVENT_SCHEMA_VERSION, type ZenEvent } from "../../src/core/events.js";
import { replay } from "../../src/core/reducer.js";
import type { DocState, MarkdownAnchor, NewThread } from "../../src/core/types.js";

export const PLAN = [
  "---",
  "title: Session storage",
  "---",
  "",
  "# Storage plan",
  "",
  "## Storage",
  "",
  "Use Redis for the session table. Cost is $O(n^2)$ in the worst case.",
  "",
  "> [!QUESTION] Which database engine? {#db-engine}",
  "> - PostgreSQL (recommended)",
  "> - SQLite",
  "",
  "> [!QUESTION:MULTI] Which modules ship first?",
  "> - auth",
  "> - billing",
  "> - search",
  "",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
  "",
  "<script>alert(1)</script>",
  "",
  "## Steps",
  "",
  "- [x] Build event log",
  "- [ ] Write daemon",
  "",
].join("\n");

const anchor = (quote: string, block: string, lines: [number, number]): MarkdownAnchor => ({
  type: "markdown",
  rev: 1,
  block,
  quote,
  prefix: "",
  suffix: "",
  lines,
});

let clock = 0;
const base = (author: string) => ({
  schemaVersion: EVENT_SCHEMA_VERSION as typeof EVENT_SCHEMA_VERSION,
  ts: new Date(Date.UTC(2026, 8, 20 + clock++, 12)).toISOString(),
  author,
});

const opened: NewThread[] = [
  {
    id: "t1",
    kind: "decision",
    question: "db-engine",
    choice: { mode: "single", option: "SQLite" },
    anchor: anchor("", "storage/q1", [11, 13]),
    body: "SQLite is enough <for now>",
    attachments: [],
  },
  {
    id: "t2",
    kind: "decision",
    question: "which-modules-ship-first",
    choice: { mode: "multi", options: ["auth", "billing"] },
    anchor: anchor("", "storage/q2", [15, 18]),
    body: "",
    attachments: [],
  },
  {
    id: "t3",
    kind: "comment",
    anchor: anchor("session table", "storage/p1", [9, 9]),
    body: "Why Redis?",
    attachments: [],
  },
  {
    id: "t4",
    kind: "suggestion",
    anchor: anchor("Use Redis", "storage/p1", [9, 9]),
    old: "Use Redis",
    new: "Use managed Redis",
    body: "",
    attachments: [],
  },
];

export function reviewedState(approved = true): DocState {
  clock = 0;
  const events: ZenEvent[] = [
    { ...base("agent"), type: "revision_published", n: 1, contentHash: "h1", summary: "first" },
    {
      ...base("reviewer"),
      type: "review_submitted",
      n: 1,
      revision: 1,
      verdict: "changes_requested",
      summary: "Needs work",
      opened,
      reopened: [],
      resolved: [],
    },
    {
      ...base("agent"),
      type: "agent_responded",
      revision: 1,
      responses: [
        { thread: "t1", action: "answered", note: "Switched to SQLite in the storage section" },
        { thread: "t3", action: "answered", note: "Latency" },
      ],
    },
    { ...base("agent"), type: "revision_published", n: 2, contentHash: "h2", summary: "addressed" },
  ];
  if (approved) {
    events.push({
      ...base("reviewer"),
      type: "review_submitted",
      n: 2,
      revision: 2,
      verdict: "approved",
      summary: "Ship it",
      opened: [],
      reopened: [],
      resolved: ["t1", "t3"],
    });
  }
  return replay(events);
}
