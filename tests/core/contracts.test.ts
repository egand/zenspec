import { describe, expect, it } from "vitest";
import { fillPath, ROUTES } from "../../src/core/api.js";
import { EVENT_SCHEMA_VERSION, type ZenEvent } from "../../src/core/events.js";

describe("core contracts", () => {
  it("types a review_submitted event", () => {
    const event: ZenEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      type: "review_submitted",
      ts: "2026-09-24T00:00:00.000Z",
      author: "reviewer",
      n: 1,
      revision: 1,
      verdict: "changes_requested",
      summary: "",
      opened: [
        {
          id: "t1",
          kind: "comment",
          body: "What about write-through?",
          attachments: [],
          anchor: {
            type: "markdown",
            rev: 1,
            block: "caching/p1",
            quote: "cache invalidation via TTL only",
            prefix: "we rely on ",
            suffix: " for sessions",
            lines: [43, 43],
          },
        },
      ],
      reopened: [],
      resolved: [],
    };
    expect(event.type).toBe("review_submitted");
  });

  it("fills route templates", () => {
    expect(
      fillPath(ROUTES.thread, { repoId: "zenspec-3f9a1c", docId: "plan", threadId: "t8" }),
    ).toBe("/api/docs/zenspec-3f9a1c/plan/threads/t8");
    expect(() => fillPath(ROUTES.doc, { repoId: "r" })).toThrow(/docId/);
  });

  it("has unique routes", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
