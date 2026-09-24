/**
 * One top-level block. The shell carries the block's identity and current lines; the body is
 * memoized on the block's source text plus a key of its decorations (§15), so a hot reload only
 * re-renders the blocks whose text changed and never re-runs Mermaid/KaTeX for the others.
 */
import type { Blockquote, Yaml } from "mdast";
import { toString } from "mdast-util-to-string";
import { memo } from "preact/compat";
import { useContext } from "preact/hooks";
import { parse as parseYaml } from "yaml";
import type { ParsedBlock } from "../../../core/types.js";
import { DocActionsContext } from "../context.js";
import { QuestionCard, type CardQuestion } from "../questions/QuestionCard.js";
import {
  renderNode,
  type BlockStep,
  type Definitions,
  type RenderCtx,
} from "../render/markdown.js";
import type { AnswerState, KbTerm } from "../types.js";

/** Everything outside a block's own text that changes how it renders. */
export interface BlockDeco {
  terms: KbTerm[];
  steps: BlockStep[];
  /** Without its lines, so moving the question doesn't re-render it. */
  question?: CardQuestion;
  answer?: AnswerState;
  definitions?: Definitions;
}

export const decoKey = (deco: BlockDeco): string => JSON.stringify(deco);

interface BodyProps {
  block: ParsedBlock;
  deco: BlockDeco;
  decoKey: string;
}

function FrontmatterCard({ node }: { node: Yaml }) {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(node.value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as never;
  } catch {
    // Invalid YAML: show the raw text below.
  }
  const entries = Object.entries(data);
  const value = (v: unknown) =>
    Array.isArray(v) ? (
      v.map((item, i) => (
        <span key={i} class="zen-fm-tag">
          {String(item)}
        </span>
      ))
    ) : (
      <span>{typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}</span>
    );
  return (
    <div class="zen-frontmatter">
      <div class="zen-frontmatter-title">Properties</div>
      {entries.length ? (
        <dl class="zen-frontmatter-grid">
          {entries.map(([key, v]) => (
            <div key={key} class="zen-frontmatter-item">
              <dt>{key}</dt>
              <dd>{value(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre>{node.value}</pre>
      )}
    </div>
  );
}

/** Callout body minus the marker line, the title, and the option list. */
function QuestionBlock({ node, ctx, deco }: { node: Blockquote; ctx: RenderCtx; deco: BlockDeco }) {
  const [head, ...rest] = node.children;
  const headLines = head ? toString(head).split("\n") : [];
  const markerTitle = headLines[0]?.replace(/^\s*\[![^\]]*\]/, "").trim();
  const extra = headLines.slice(1).join(" ").trim();
  const optionList = rest.find((child) => child.type === "list");
  let body = rest.filter((child) => child !== optionList);
  if (!markerTitle) {
    const titleNode = body.find((c) => c.type === "heading" || c.type === "paragraph");
    body = body.filter((c) => c !== titleNode);
  }
  return (
    <QuestionCard question={deco.question!} answer={deco.answer}>
      {(extra || body.length > 0) && (
        <div class="zen-question-desc">
          {extra && <p>{extra}</p>}
          {body.map((child, i) => renderNode(child, ctx, i))}
        </div>
      )}
    </QuestionCard>
  );
}

/** Exported (unmemoized) so tests can count how often a block body renders. */
export function BlockBody({ block, deco }: BodyProps) {
  const ctx: RenderCtx = {
    blockId: block.id,
    startLine: block.lines[0],
    terms: deco.terms,
    claimed: new Set(),
    steps: deco.steps,
    nextStep: 0,
    definitions: deco.definitions ?? {},
    inLink: false,
  };
  const { node } = block;
  if (node.type === "yaml") return <FrontmatterCard node={node} />;
  if (node.type === "blockquote" && deco.question) {
    return <QuestionBlock node={node} ctx={ctx} deco={deco} />;
  }
  return <>{renderNode(node, ctx)}</>;
}

const MemoBody = memo(
  BlockBody,
  (prev, next) =>
    prev.block.source === next.block.source &&
    prev.block.id === next.block.id &&
    prev.decoKey === next.decoKey,
);

export function Block({ block, deco }: { block: ParsedBlock; deco: BlockDeco }) {
  const { selectBlock } = useContext(DocActionsContext);
  return (
    <div
      class={`zen-block zen-block-${block.type}`}
      data-block-id={block.id}
      data-line-start={block.lines[0]}
      data-line-end={block.lines[1]}
    >
      <button
        type="button"
        class="zen-gutter"
        data-zen-ui
        title="Comment on this block"
        aria-label="Comment on this block"
        onClick={(e) => selectBlock(block.id, e.currentTarget.parentElement!)}
      />
      <MemoBody block={block} deco={deco} decoKey={decoKey(deco)} />
    </div>
  );
}
