import { describe, expect, it } from "vitest";
import { fillPath, ROUTES } from "../../src/core/api.js";

describe("core contracts", () => {
  it("fills route templates", () => {
    expect(
      fillPath(ROUTES.attachment, { repoId: "zenspec-3f9a1c", docId: "plan", attachmentId: "t8" }),
    ).toBe("/api/docs/zenspec-3f9a1c/plan/attachments/t8");
    expect(() => fillPath(ROUTES.doc, { repoId: "r" })).toThrow(/docId/);
  });

  it("has unique routes", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
