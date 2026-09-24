/** Threads by status, each with its message history (agent replies live here only, §9.1). */
import { useEffect } from "preact/hooks";
import type { Message, Thread, ThreadStatus } from "../../core/types.js";
import { useApp } from "../app/actions.js";
import { stagedAction, type StagedAction } from "../store/draft.js";
import { describeChoice, likelyAddressedHint, linkIn, noteFor, quoteOf } from "../store/view.js";
import { Thumbnails } from "./Attachments.js";
import { WordDiffView } from "./Composer.js";
import { useScrollWhenActive } from "./hooks.js";

const GROUPS: { title: string; statuses: ThreadStatus[] }[] = [
  { title: "Open", statuses: ["open"] },
  { title: "Addressed", statuses: ["addressed", "declined"] },
  { title: "Outdated", statuses: ["outdated"] },
  { title: "Resolved", statuses: ["resolved"] },
];

export function ThreadsTab() {
  const { store } = useApp();
  const threads = store.threads.value;
  const latestN = store.latest.value?.n ?? 0;

  // Revision texts needed for the "likely addressed" hint.
  useEffect(() => {
    const revs = new Set<number>();
    for (const t of threads) {
      if (t.status === "open" && t.kind !== "general" && t.anchor.type === "markdown") {
        revs.add(t.anchor.rev);
      }
    }
    if (revs.size) revs.add(latestN);
    for (const n of revs) if (n > 0) store.loadRevision(n).catch(() => {});
  }, [threads, latestN]);

  if (!threads.length) {
    return (
      <div class="zen-tab-pane">
        <div class="zen-scroll">
          <p class="zen-empty">No threads yet. Submitted review items appear here.</p>
        </div>
      </div>
    );
  }
  return (
    <div class="zen-tab-pane">
      <div class="zen-scroll">
        {GROUPS.map((g) => {
          const list = threads.filter((t) => g.statuses.includes(t.status));
          if (!list.length) return null;
          return (
            <section key={g.title}>
              <h3 class="zen-section-title">
                {g.title} <span class="zen-count">{list.length}</span>
              </h3>
              {list.map((t) => (
                <ThreadCard key={t.id} thread={t} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

const ACTION_LABEL: Record<Message["action"], string> = {
  comment: "",
  reopened: "reopened",
  reply: "replied",
  resolved: "resolved",
  edited: "edited the document",
  answered: "answered",
  declined: "declined",
};

export function ThreadCard({ thread }: { thread: Thread }) {
  const { store, ui, actions } = useApp();
  const staged = stagedAction(store.draft.value, thread.id);
  const active = ui.active.value === thread.id;
  const ref = useScrollWhenActive<HTMLElement>(active);
  const quote = quoteOf(thread);
  const matched = thread.placement?.matched;
  const hint = likelyAddressedHint(thread, store.latest.value?.n ?? 0, store.revisionTexts.value);
  const note = thread.kind === "explain" ? noteFor(thread.term, store.kbNotes.value) : undefined;
  const noteLink =
    note?.url ??
    thread.messages
      .map((m) => (m.author !== "reviewer" ? linkIn(m.body) : undefined))
      .findLast(Boolean);

  return (
    <article
      class={`zen-card zen-thread-card status-${thread.status}${active ? " active" : ""}`}
      data-id={thread.id}
      ref={ref}
    >
      <div class="zen-card-head">
        <button type="button" class="zen-link" onClick={() => actions.focusThread(thread.id)}>
          {thread.id}
        </button>
        <span class={`zen-tag zen-tag-${thread.kind}`}>{thread.kind}</span>
        <span class={`zen-thread-status zen-thread-status-${thread.status}`}>{thread.status}</span>
        {hint && (
          <span class="zen-hint" title="The latest revision changed this region">
            likely addressed
          </span>
        )}
      </div>
      {thread.kind === "suggestion" ? (
        <WordDiffView oldText={thread.old} newText={thread.new} />
      ) : (
        quote && <blockquote class="zen-quote">{quote}</blockquote>
      )}
      {quote && matched && matched !== quote && thread.status !== "resolved" && (
        <p class="zen-muted zen-small">Now: “{matched}”</p>
      )}
      {thread.kind === "decision" && (
        <p class="zen-body">
          <span class="zen-muted">
            {store.questions.value.find((q) => q.id === thread.question)?.title ?? thread.question}{" "}
            →
          </span>{" "}
          <strong>{describeChoice(thread.choice)}</strong>
        </p>
      )}
      {thread.kind === "explain" && (
        <p class="zen-body">
          Explain <strong>{thread.term}</strong>
          {noteLink && (
            <>
              {" · "}
              <a class="zen-link" href={noteLink} target="_blank" rel="noreferrer">
                Open note
              </a>
            </>
          )}
        </p>
      )}
      <ol class="zen-messages">
        {thread.messages.map((m, i) =>
          !m.body && !m.attachments.length && m.action === "comment" ? null : (
            <li
              key={i}
              class={`zen-message from-${m.author === "reviewer" ? "reviewer" : "agent"}`}
            >
              <div class="zen-message-meta">
                <strong>{m.author}</strong> {ACTION_LABEL[m.action]}
                <time dateTime={m.ts}>{formatTime(m.ts)}</time>
              </div>
              {m.body && <p class="zen-body">{m.body}</p>}
              <Thumbnails attachments={m.attachments} />
            </li>
          ),
        )}
      </ol>
      <ThreadActions thread={thread} staged={staged} />
    </article>
  );
}

function ThreadActions({ thread, staged }: { thread: Thread; staged: StagedAction | null }) {
  const { ui, actions } = useApp();
  if (thread.status === "resolved") return null;
  if (staged) {
    return (
      <div class="zen-card-actions">
        <span class="zen-staged">{staged === "resolve" ? "Resolve staged" : "Reply staged"}</span>
        <button type="button" class="zen-btn-sm" onClick={() => actions.unstage(thread.id)}>
          Undo
        </button>
      </div>
    );
  }
  const canReopen = thread.status !== "open";
  return (
    <div class="zen-card-actions">
      <button
        type="button"
        class="zen-btn-sm zen-btn-resolve"
        onClick={() => actions.resolve(thread.id)}
      >
        Resolve
      </button>
      <button
        type="button"
        class="zen-btn-sm"
        onClick={() => (ui.composer.value = { mode: "reply", threadId: thread.id })}
      >
        Reply
      </button>
      {canReopen && (
        <button type="button" class="zen-btn-sm" onClick={() => actions.reopen(thread.id, "")}>
          Reopen
        </button>
      )}
    </div>
  );
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
