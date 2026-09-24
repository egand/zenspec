import { describe, expect, it } from "vitest";
import { parseDocument } from "../../../src/core/parse.js";
import type { Thread } from "../../../src/core/types.js";
import {
  acceptRecommended,
  addThread,
  emptyDraft,
  setAnswer,
  stageReopen,
  stageReply,
  stageResolve,
  stagedAction,
  toSubmitRequest,
  unansweredQuestions,
  unstage,
} from "../../../src/client/store/draft.js";
import { answersFor } from "../../../src/client/store/view.js";
import { DOC_TEXT } from "./fakes.js";

const questions = parseDocument(DOC_TEXT).questions;
const [database, queue] = questions as [(typeof questions)[0], (typeof questions)[0]];

describe("answers (§9.1)", () => {
  it("never queues the recommended option on its own", () => {
    expect(database.recommended).toBe("PostgreSQL");
    const draft = emptyDraft(1);
    expect(draft.threads).toEqual([]);
    expect(answersFor([], draft, questions)).toEqual({});
    expect(unansweredQuestions(questions, draft, []).map((q) => q.id)).toEqual([
      database.id,
      queue.id,
    ]);
  });

  it("creates a decision only when an option is picked, and clears it with null", () => {
    let draft = setAnswer(emptyDraft(1), queue, { mode: "single", option: "SQS" }, "cheaper");
    expect(draft.threads).toHaveLength(1);
    expect(answersFor([], draft, questions)[queue.id]).toEqual({
      choice: { mode: "single", option: "SQS" },
      note: "cheaper",
      state: "draft",
    });

    draft = setAnswer(draft, queue, { mode: "single", option: "Kafka" });
    expect(draft.threads).toHaveLength(1);
    draft = setAnswer(draft, queue, null);
    expect(draft.threads).toEqual([]);
  });

  it("accepts recommended options only for the questions asked", () => {
    const draft = acceptRecommended(emptyDraft(1), [database, queue]);
    // `queue` has no recommended option, so it stays unanswered.
    expect(draft.threads).toMatchObject([
      { kind: "decision", question: database.id, choice: { mode: "single", option: "PostgreSQL" } },
    ]);
    expect(unansweredQuestions(questions, draft, []).map((q) => q.id)).toEqual([queue.id]);
  });

  it("counts a submitted decision as answered", () => {
    const submitted = {
      id: "t1",
      kind: "decision",
      question: queue.id,
      choice: { mode: "single", option: "SQS" },
      anchor: {
        type: "markdown",
        rev: 1,
        block: "b",
        quote: "",
        prefix: "",
        suffix: "",
        lines: [1, 1],
      },
      status: "open",
      messages: [],
      openedIn: 1,
    } as Thread;
    expect(unansweredQuestions(questions, null, [submitted]).map((q) => q.id)).toEqual([
      database.id,
    ]);
  });
});

describe("thread actions", () => {
  it("stages resolve and reopen exclusively, and unstages", () => {
    let draft = stageResolve(emptyDraft(1), "t1");
    expect(stagedAction(draft, "t1")).toBe("resolve");

    draft = stageReopen(draft, "t1", "not fixed");
    expect(stagedAction(draft, "t1")).toBe("reopen");
    expect(draft.resolve).toEqual([]);
    expect(draft.reopen).toEqual([{ thread: "t1", body: "not fixed", attachments: [] }]);

    draft = unstage(draft, "t1");
    expect(stagedAction(draft, "t1")).toBeNull();
  });
});

describe("toSubmitRequest", () => {
  it("maps the draft to a SubmitReviewRequest", () => {
    let draft = addThread(emptyDraft(1), { kind: "general" }, "add a rollback section", [
      { id: "abcdef123456", mime: "image/png", width: 10, height: 20 },
    ]);
    draft = { ...draft, threads: draft.threads.map((t) => ({ ...t, orphaned: true })) };
    draft = stageReopen(stageResolve(draft, "t2"), "t3", "still unclear");
    draft = stageReply(draft, "t4", "one more thing");

    expect(toSubmitRequest(draft, 4, "changes_requested", "Needs work")).toEqual({
      revision: 4,
      verdict: "changes_requested",
      summary: "Needs work",
      opened: [
        {
          kind: "general",
          body: "add a rollback section",
          attachments: [{ id: "abcdef123456", mime: "image/png", width: 10, height: 20 }],
        },
      ],
      reopened: [{ id: "t3", body: "still unclear", attachments: [] }],
      replies: [{ thread: "t4", body: "one more thing" }],
      resolved: ["t2"],
    });
  });
});
