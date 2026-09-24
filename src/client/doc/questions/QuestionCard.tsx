/**
 * `[!QUESTION]` cards (§9.1). The recommended option is marked but never pre-selected; an answer
 * exists only after the reviewer clicks. Every change goes through `answer` (→ `onAnswer`).
 */
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type { Choice, Question } from "../../../core/types.js";
import { DocActionsContext } from "../context.js";
import type { AnswerState } from "../types.js";

/** The parts of a question the card shows (no position, so moves don't re-render it). */
export type CardQuestion = Pick<Question, "id" | "mode" | "title" | "options" | "recommended">;

interface Props {
  question: CardQuestion;
  answer?: AnswerState;
  /** Extra description rendered from the callout body. */
  children?: ComponentChildren;
}

const DEFAULT_SCALE = 5;

function isSelected(choice: Choice | undefined, option: string): boolean {
  if (!choice) return false;
  if (choice.mode === "single") return choice.option === option;
  if (choice.mode === "multi") return choice.options.includes(option);
  return false;
}

function WriteIn(props: {
  name: string;
  type: "radio" | "checkbox";
  selected: boolean;
  value: string;
  disabled: boolean;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed && trimmed !== props.value) props.onCommit(trimmed);
  };
  return (
    <label class={`zen-option zen-option-other${props.selected ? " is-selected" : ""}`}>
      <input
        type={props.type}
        name={props.name}
        checked={props.selected}
        disabled={props.disabled}
        onChange={() => text.trim() && props.onCommit(text.trim())}
      />
      <input
        type="text"
        class="zen-option-write-in"
        placeholder="Other: write your own answer…"
        value={text}
        disabled={props.disabled}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
}

export function QuestionCard({ question, answer, children }: Props) {
  const { answer: send } = useContext(DocActionsContext);
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [answer?.state]);

  const locked = answer?.state === "submitted" && !editing;
  const choice = answer?.choice;
  const { id, mode, options, recommended } = question;
  const set = (next: Choice | null, note?: string) => send(id, next, note);
  const writeIn = choice?.mode === "other" ? (answer?.note ?? "") : "";

  const toggle = (option: string) => {
    if (mode === "single") return set({ mode: "single", option });
    const current = choice?.mode === "multi" ? choice.options : [];
    const next = current.includes(option)
      ? current.filter((o) => o !== option)
      : options.filter((o) => o === option || current.includes(o));
    set(next.length ? { mode: "multi", options: next } : null);
  };

  const scale = options.length || DEFAULT_SCALE;
  const rating = choice?.mode === "rating" ? choice.value : undefined;

  return (
    <div
      class={`zen-question${locked ? " is-locked" : ""}${answer ? ` is-${answer.state}` : ""}`}
      data-question-id={id}
    >
      <div class="zen-question-head">
        <span class="zen-question-title">{question.title}</span>
        <span class="zen-question-mode">
          {mode === "multi" ? "Select all that apply" : mode === "rating" ? "Rating" : "Choose one"}
        </span>
        {answer?.state === "submitted" && <span class="zen-question-answered">✓ Answered</span>}
        {answer?.state === "draft" && <span class="zen-question-draft">Draft</span>}
      </div>
      {children}

      {mode === "rating" ? (
        <div class="zen-rating" role="radiogroup">
          {Array.from({ length: scale }, (_, i) => i + 1).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rating === value}
              class={`zen-rating-btn${rating === value ? " is-selected" : ""}${
                options[value - 1] !== undefined && options[value - 1] === recommended
                  ? " is-recommended"
                  : ""
              }`}
              disabled={locked}
              onClick={() => set({ mode: "rating", value })}
            >
              <span class="zen-rating-num">{value}</span>
              {options[value - 1] && <span class="zen-rating-label">{options[value - 1]}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div class="zen-options">
          {options.map((option) => {
            const selected = isSelected(choice, option);
            const rec = option === recommended;
            return (
              <label
                key={option}
                class={`zen-option${selected ? " is-selected" : ""}${rec ? " is-recommended" : ""}`}
              >
                <input
                  type={mode === "multi" ? "checkbox" : "radio"}
                  name={`zen-q-${id}`}
                  checked={selected}
                  disabled={locked}
                  onChange={() => toggle(option)}
                />
                <span class="zen-option-text">{option}</span>
                {rec && <span class="zen-option-rec">Recommended</span>}
              </label>
            );
          })}
          <WriteIn
            name={`zen-q-${id}`}
            type={mode === "multi" ? "checkbox" : "radio"}
            selected={choice?.mode === "other"}
            value={writeIn}
            disabled={locked}
            onCommit={(text) => set({ mode: "other" }, text)}
          />
        </div>
      )}

      <div class="zen-question-foot">
        {locked ? (
          <button type="button" class="zen-link-btn" onClick={() => setEditing(true)}>
            Edit answer
          </button>
        ) : (
          choice && (
            <button type="button" class="zen-link-btn" onClick={() => set(null)}>
              Clear
            </button>
          )
        )}
        {!answer && recommended && (
          <span class="zen-question-hint">Recommended: {recommended}</span>
        )}
      </div>
    </div>
  );
}
