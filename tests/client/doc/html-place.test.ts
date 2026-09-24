import { describe, expect, it } from "vitest";
import { placeHtmlHighlights } from "../../../src/client/doc/html/place.js";
import { pinLabel } from "../../../src/client/doc/overlay/Overlay.js";
import type { DocHighlight } from "../../../src/client/doc/types.js";
import { highlightsFor } from "../../../src/client/store/view.js";
import type { HtmlAnchor, Thread } from "../../../src/core/types.js";

const anchor: HtmlAnchor = {
  type: "html",
  rev: 1,
  cssPath: "main > button:nth-of-type(2)",
  tag: "button",
  textQuote: "Sign up",
};

const highlight = (threadId: string, a = anchor): DocHighlight => ({
  threadId,
  status: "open",
  kind: "comment",
  htmlAnchor: a,
});

describe("HTML re-anchoring in the browser", () => {
  it("follows an element that moved, by its text among same-tag elements", () => {
    const elements = [
      { cssPath: "main > button:nth-of-type(1)", tag: "button", text: "Log in" },
      { cssPath: "header > button", tag: "button", text: "Sign up" },
    ];
    expect(placeHtmlHighlights([highlight("t1")], elements)).toEqual([
      { threadId: "t1", cssPath: "header > button", status: "open" },
    ]);
  });

  it("uses the original CSS path until the page reports, and drops anchors that are gone", () => {
    expect(placeHtmlHighlights([highlight("t1")], null)[0]?.cssPath).toBe(anchor.cssPath);
    expect(placeHtmlHighlights([highlight("t1")], [{ cssPath: "p", tag: "p", text: "x" }])).toEqual(
      [],
    );
  });

  it("gets HTML anchors from submitted threads and draft items", () => {
    const thread = {
      id: "t4",
      kind: "comment",
      anchor,
      status: "open",
      messages: [],
      openedIn: 1,
    } as Thread;
    expect(highlightsFor([thread], null)).toEqual([
      { threadId: "t4", status: "open", kind: "comment", htmlAnchor: anchor },
    ]);
  });
});

describe("margin pins", () => {
  it("shows the kind icon and thread number; the id only in the tooltip", () => {
    const pin = pinLabel({ threadId: "t12", kind: "suggestion", status: "open" });
    expect([pin.icon, pin.number]).toEqual(["±", "12"]);
    expect(pin.title).toBe("Thread t12 · suggestion · open");
  });

  it("marks draft items with + instead of their random id", () => {
    const pin = pinLabel({ threadId: "dx7k2", kind: "comment", status: "open" });
    expect([pin.icon, pin.number]).toEqual(["❝", "+"]);
    expect(pin.title).toContain("dx7k2");
  });
});
