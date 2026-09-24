// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { SubmitDialog } from "../../../src/client/review/SubmitDialog.js";
import { handleShortcut } from "../../../src/client/app/shortcuts.js";
import { RequestError } from "../../../src/client/store/api.js";
import { parseDocument } from "../../../src/core/parse.js";
import { DOC_TEXT, fakeApi } from "../store/fakes.js";
import { button, click, mount, settle, type } from "./harness.js";

const dbQuestion = parseDocument(DOC_TEXT).questions[0]!;

describe("submit review", () => {
  it("asks once about unanswered questions, then can leave them unanswered", async () => {
    const { app, api, root } = await mount(<SubmitDialog />);
    await settle(() => app.actions.openSubmit("approved"));

    await type(root.querySelector("textarea")!, "Looks good");
    await click(button(root, "Submit review"));
    expect(root.textContent).toContain("2 questions have no answer");
    expect(api.submitReview).not.toHaveBeenCalled();

    await click(button(root, "Leave unanswered"));
    await settle();
    expect(api.submitReview).toHaveBeenCalledWith({
      revision: 1,
      verdict: "approved",
      summary: "Looks good",
      opened: [],
      reopened: [],
      resolved: [],
    });
    expect(app.ui.submit.value).toBeNull();
  });

  it("accepts the recommended option only when asked to", async () => {
    const { app, api, root } = await mount(<SubmitDialog />);
    await settle(() => app.actions.openSubmit("changes_requested"));

    await click(button(root, "Submit review"));
    await click(button(root, /Accept recommended for 1/));
    await settle();

    const request = api.submitReview.mock.calls[0]![0];
    expect(request.verdict).toBe("changes_requested");
    expect(request.opened).toEqual([
      expect.objectContaining({
        kind: "decision",
        question: dbQuestion.id,
        choice: { mode: "single", option: "PostgreSQL" },
      }),
    ]);
  });

  it("submits directly when every question is answered, and reports a stale revision", async () => {
    const api = fakeApi({ content: "# Plan\n\nNo questions here.\n" });
    api.submitReview.mockRejectedValueOnce(
      new RequestError(409, "conflict", "Review targets revision 1, but the latest is 2"),
    );
    const { app, root } = await mount(<SubmitDialog />, api);
    await settle(() => app.actions.openSubmit());

    await click(button(root, "Submit review"));
    await settle();
    expect(api.submitReview).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("Review the new revision first");
  });
});

describe("shortcuts", () => {
  it("`a` opens submit with Approve, but not while typing", async () => {
    const { app } = await mount(null);
    const textarea = document.createElement("textarea");
    document.body.append(textarea);

    const typing = new KeyboardEvent("keydown", { key: "a" });
    Object.defineProperty(typing, "target", { value: textarea });
    expect(handleShortcut(typing, app)).toBe(false);
    expect(app.ui.submit.value).toBeNull();

    expect(handleShortcut(new KeyboardEvent("keydown", { key: "a" }), app)).toBe(true);
    expect(app.ui.submit.value).toEqual({ verdict: "approved" });

    expect(handleShortcut(new KeyboardEvent("keydown", { key: "Escape" }), app)).toBe(true);
    expect(app.ui.submit.value).toBeNull();
  });
});
