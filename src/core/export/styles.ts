/** Stylesheet inlined into the HTML export. Same palette as the app, light by default. */
export const EXPORT_CSS = `
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --bg: #ffffff; --bg-soft: #f6f8fa; --border: #d0d7de;
  --text: #1f2328; --muted: #656d76;
  --accent: #0969da; --green: #1a7f37; --yellow: #9a6700; --red: #cf222e; --purple: #8250df;
  --added: rgba(46, 160, 67, 0.15); --removed: rgba(218, 54, 51, 0.15);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --bg-soft: #161b22; --border: #30363d;
    --text: #f0f6fc; --muted: #8b949e;
    --accent: #3b82f6; --green: #2ea043; --yellow: #d29922; --red: #da3633; --purple: #8957e5;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 var(--font-sans); }
.zen-export { max-width: 860px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.zen-export-meta { color: var(--muted); font-size: 0.875rem; border-bottom: 1px solid var(--border); padding-bottom: 0.75rem; margin-bottom: 2rem; }
.zen-export-meta code { font-size: 0.85em; }
.zen-badge { display: inline-block; padding: 0 0.5em; border-radius: 999px; border: 1px solid var(--border); font-size: 0.75rem; line-height: 1.6; color: var(--muted); }
.zen-badge-approved, .zen-badge-done, .zen-badge-resolved, .zen-badge-implementing { color: var(--green); border-color: var(--green); }
.zen-badge-changes_requested, .zen-badge-open { color: var(--yellow); border-color: var(--yellow); }
.zen-badge-addressed { color: var(--accent); border-color: var(--accent); }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 2em; } h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
a { color: var(--accent); }
code { font-family: var(--font-mono); font-size: 0.875em; background: var(--bg-soft); padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px; padding: 0.9rem 1rem; overflow-x: auto; }
pre code { background: none; padding: 0; }
.zen-code { position: relative; }
.zen-code-lang { position: absolute; top: 0.35rem; right: 0.6rem; font-size: 0.7rem; color: var(--muted); }
pre.mermaid { background: none; text-align: center; }
blockquote { margin: 1em 0; padding: 0 1em; color: var(--muted); border-left: 4px solid var(--border); }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
.zen-table-wrapper { overflow-x: auto; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid var(--border); padding: 0.4em 0.8em; }
th { background: var(--bg-soft); }
.zen-task-list { list-style: none; padding-left: 1.2em; }
.zen-task-done { color: var(--muted); }
.zen-math { overflow-x: auto; margin: 1em 0; text-align: center; }
.zen-raw-html { white-space: pre-wrap; }
.zen-callout, .zen-question { border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 6px; padding: 0.5rem 1rem; margin: 1em 0; background: var(--bg-soft); }
.zen-callout-warning, .zen-callout-caution { border-left-color: var(--red); }
.zen-callout-tip { border-left-color: var(--green); }
.zen-callout-important { border-left-color: var(--purple); }
.zen-callout-title, .zen-question-label { font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.zen-question-title { font-weight: 600; margin: 0.25em 0 0.5em; }
.zen-question ul { padding-left: 1.2em; }
.zen-option-chosen { font-weight: 600; color: var(--green); }
.zen-option-tag { font-size: 0.75rem; color: var(--muted); font-weight: normal; }
.zen-question-answer { border-top: 1px dashed var(--border); padding-top: 0.5em; }
.zen-trail { margin-top: 4rem; }
.zen-decision, .zen-thread { border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
.zen-thread-head { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; font-size: 0.875rem; }
.zen-thread-quote { margin: 0.5em 0; }
.zen-suggestion del { background: var(--removed); text-decoration: line-through; }
.zen-suggestion ins { background: var(--added); text-decoration: none; }
.zen-messages { list-style: none; padding: 0; margin: 0.5em 0 0; }
.zen-messages li { border-top: 1px solid var(--border); padding: 0.4em 0; }
.zen-message-head { font-size: 0.8rem; color: var(--muted); }
.zen-message-body { white-space: pre-wrap; }
.zen-history { padding-left: 1.2em; }
.zen-muted { color: var(--muted); }
iframe.zen-mockup { width: 100%; min-height: 70vh; border: 1px solid var(--border); border-radius: 6px; background: #fff; }
`;
