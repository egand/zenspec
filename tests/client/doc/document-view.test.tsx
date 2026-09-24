// @vitest-environment happy-dom
import { options, render, type VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockBody } from "../../../src/client/doc/blocks/Block.js";
import { DocumentView, type DocumentViewProps } from "../../../src/client/doc/index.js";

vi.mock("../../../src/client/doc/mermaid/render.js", () => ({
  renderMermaid: vi.fn(async () => '<svg viewBox="0 0 100 50"></svg>'),
}));
const { renderMermaid } = await import("../../../src/client/doc/mermaid/render.js");

const md = (...lines: string[]): string => lines.join("\n") + "\n";

const PLAN = md(
  "# Plan",
  "",
  "Intro paragraph about the TTL.",
  "",
  "## Caching",
  "",
  "```ts",
  "const TTL = 60;",
  "```",
  "",
  "We cache **reads** with a TTL.",
  "",
  "```mermaid",
  "graph TD; A-->B",
  "```",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  "> [!QUESTION] Which database should we use?",
  ">",
  "> - [ ] **(Recommended) PostgreSQL**: reliable",
  "> - [ ] SQLite: embedded",
  "",
  "## Steps",
  "",
  "- [x] Build event log",
  "- [ ] Write reducer",
);

const QUESTION = "which-database-should-we-use";

let host: HTMLElement;

function props(overrides: Partial<DocumentViewProps> = {}): DocumentViewProps {
  return {
    kind: "markdown",
    source: PLAN,
    highlights: [],
    answers: {},
    onSelect: vi.fn(),
    onAnswer: vi.fn(),
    onHighlightClick: vi.fn(),
    ...overrides,
  };
}

async function show(p: DocumentViewProps) {
  await act(async () => {
    render(<DocumentView {...p} />, host);
  });
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  localStorage.clear();
});

afterEach(() => {
  render(null, host);
  host.remove();
});

describe("keyed rendering (§15)", () => {
  const renders = new Map<string, number>();
  let previous: typeof options.diffed;

  beforeEach(() => {
    renders.clear();
    previous = options.diffed;
    options.diffed = (vnode: VNode<any>) => {
      if (vnode.type === BlockBody) {
        const id = (vnode.props as { block: { id: string } }).block.id;
        renders.set(id, (renders.get(id) ?? 0) + 1);
      }
      previous?.(vnode);
    };
  });

  afterEach(() => {
    options.diffed = previous;
  });

  it("re-renders only the edited block, even when later lines shift", async () => {
    const p = props();
    await show(p);
    expect([...renders.values()].every((n) => n === 1)).toBe(true);
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    const mermaidNode = $("[data-block-id='caching/c2'] .zen-mermaid");
    const mathNode = $(".zen-math");

    renders.clear();
    const edited = PLAN.replace(
      "Intro paragraph about the TTL.",
      "Intro paragraph,\nnow on two lines.",
    );
    await show({ ...p, source: edited });

    expect([...renders.keys()]).toEqual(["plan/p1"]);
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect($("[data-block-id='caching/c2'] .zen-mermaid")).toBe(mermaidNode);
    expect($(".zen-math")).toBe(mathNode);
    // The shell still reports the shifted lines.
    expect($("[data-block-id='caching/p1']")?.dataset.lineStart).toBe("12");
  });
});

describe("question cards (§9.1)", () => {
  it("marks the recommended option without selecting it", async () => {
    const p = props();
    await show(p);
    const card = $(`[data-question-id='${QUESTION}']`)!;
    expect($$<HTMLInputElement>(".zen-question input").some((i) => i.checked)).toBe(false);
    const recommended = card.querySelector(".zen-option.is-recommended")!;
    expect(recommended.textContent).toContain("PostgreSQL");
    expect(recommended.classList.contains("is-selected")).toBe(false);

    await act(() => card.querySelectorAll<HTMLInputElement>("input[type=radio]")[1]!.click());
    expect(p.onAnswer).toHaveBeenCalledWith(
      QUESTION,
      { mode: "single", option: "SQLite: embedded" },
      undefined,
    );
  });

  it("locks a submitted answer until Edit answer is clicked", async () => {
    await show(
      props({
        answers: {
          [QUESTION]: {
            choice: { mode: "single", option: "SQLite: embedded" },
            state: "submitted",
          },
        },
      }),
    );
    const inputs = () => $$<HTMLInputElement>(".zen-question input");
    expect($(".zen-question-answered")?.textContent).toContain("Answered");
    expect(inputs().every((i) => i.disabled)).toBe(true);
    expect($(".zen-option.is-selected")?.textContent).toContain("SQLite");

    const edit = $$("button").find((b) => b.textContent === "Edit answer")!;
    await act(() => edit.click());
    expect(inputs().some((i) => i.disabled)).toBe(false);
  });
});

describe("knowledge-base terms (§11)", () => {
  const ttl = { term: "TTL", aliases: ["time to live"], summary: "Expiry.", link: "http://kb/ttl" };

  it("underlines only the first prose occurrence, and Got it hides it", async () => {
    await show(props({ kbTerms: [ttl] }));
    const marks = $$(".zen-kb-term");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest("[data-block-id]")?.getAttribute("data-block-id")).toBe("plan/p1");

    await act(() => void marks[0]!.dispatchEvent(new Event("mouseenter")));
    expect($(".zen-kb-card a")?.getAttribute("href")).toBe("http://kb/ttl");
    const gotIt = $$("button").find((b) => b.textContent === "Got it")!;
    await act(() => gotIt.click());
    expect($$(".zen-kb-term")).toHaveLength(0);
    expect(localStorage.getItem("zen-kb-dismissed")).toContain("TTL");
  });
});

describe("living-plan steps (§10)", () => {
  it("renders read-only checkboxes with a checked timestamp and a progress count", async () => {
    await show(
      props({
        steps: { "steps/build-event-log": { checked: true, checkedAt: "2026-09-24T10:00:00Z" } },
      }),
    );
    const boxes = $$<HTMLInputElement>(".zen-task-box");
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(boxes[0]!.title).toMatch(/^Checked /);
    expect($(".zen-step-current")?.textContent).toContain("Write reducer");
    expect($(".zen-steps-count")?.textContent).toBe("1/2 steps");
  });
});

describe("selection toolbar", () => {
  it("maps a text selection over bold text to source offsets", async () => {
    const p = props();
    await show(p);
    const strong = $("[data-block-id='caching/p1'] strong")!;
    const range = document.createRange();
    range.setStart(strong.firstChild!, 0);
    range.setEnd(strong.nextSibling!, 5); // "reads" + " with"
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    await act(
      () => void $(".zen-doc-body")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })),
    );

    await act(() => $<HTMLButtonElement>(".zen-sel-toolbar [data-action=suggest]")!.click());
    const start = PLAN.indexOf("reads**");
    expect(p.onSelect).toHaveBeenCalledWith({
      blockId: "caching/p1",
      quote: "reads** with",
      start,
      end: start + "reads** with".length,
      lines: [11, 11],
      action: "suggest",
    });
  });

  it("selects the whole block from the gutter", async () => {
    const p = props();
    await show(p);
    await act(() => $<HTMLButtonElement>("[data-block-id='caching/p1'] .zen-gutter")!.click());
    await act(() => $<HTMLButtonElement>(".zen-sel-toolbar [data-action=comment]")!.click());
    expect(p.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "caching/p1", quote: "We cache **reads** with a TTL." }),
    );
  });
});
