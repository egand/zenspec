import { describe, expect, it } from "vitest";
import { escapeHtml, safeUrl } from "../../src/core/html.js";

describe("shared HTML helpers", () => {
  it("escapes text for content and quoted attributes", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });

  it.each(["https://example.com", "mailto:a@b.c", "#intro", "/abs", "./rel.png", "docs/a.md"])(
    "keeps the safe URL %s",
    (url) => expect(safeUrl(url)).toBe(url),
  );

  it.each(["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "vbscript:x"])(
    "drops the unsafe URL %s",
    (url) => expect(safeUrl(url)).toBeUndefined(),
  );
});
