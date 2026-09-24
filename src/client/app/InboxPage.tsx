/** Open reviews across every repo served by the daemon (§9.2 "Inbox"). */
import { useEffect, useState } from "preact/hooks";
import type { InboxItem } from "../../core/api.js";
import { fetchInbox } from "../store/api.js";
import { Bar, Brand, PhaseBadge, ThemeToggle } from "./TopBar.js";

export function groupByRepo(items: readonly InboxItem[]): [string, InboxItem[]][] {
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) {
    const list = groups.get(item.doc.repoRoot) ?? [];
    list.push(item);
    groups.set(item.doc.repoRoot, list);
  }
  for (const list of groups.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...groups];
}

/** Keeps the link on the page's own origin (the daemon returns absolute URLs). */
function localHref(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function InboxPage() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Inbox · ZenSpec";
    const load = () =>
      fetchInbox()
        .then((r) => {
          setItems(r.items);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div class="zen-app">
      <Bar>
        <Brand />
        <div class="zen-doc-title">
          <span class="zen-doc-name">Inbox</span>
        </div>
        <span class="zen-spacer" />
        <ThemeToggle />
      </Bar>
      <main class="zen-inbox">
        {error && <p class="zen-error">Could not load the inbox: {error}</p>}
        {!items && !error && <p class="zen-muted">Loading…</p>}
        {items?.length === 0 && <p class="zen-empty">No open reviews.</p>}
        {items &&
          groupByRepo(items).map(([repo, list]) => (
            <section key={repo} class="zen-inbox-repo">
              <h2 class="zen-section-title">{repo}</h2>
              <ul class="zen-inbox-list">
                {list.map((item) => (
                  <li key={item.doc.docId}>
                    <a class="zen-inbox-item" href={localHref(item.url)}>
                      <span class="zen-inbox-name">{item.doc.relPath}</span>
                      <PhaseBadge phase={item.doc.phase} />
                      <span class="zen-chip">r{item.lastRevision}</span>
                      {item.lastVerdict && (
                        <span class={`zen-verdict-chip zen-verdict-${item.lastVerdict}`}>
                          {item.lastVerdict.replace("_", " ")}
                        </span>
                      )}
                      <span class="zen-spacer" />
                      <span class="zen-muted zen-small">
                        {item.openThreads} open ·{" "}
                        {item.updatedAt && new Date(item.updatedAt).toLocaleString()}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </main>
    </div>
  );
}
