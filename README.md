# ZenSpec

Human review for agent-written plans. The agent writes a plan in Markdown, you review it in the browser like a pull request (comments, suggestions, answers to its questions, a verdict), and the agent gets your review back as compact YAML. It starts implementing only after you approve.

- **One CLI call per review round.** `zenspec review <file>` publishes the plan, records the agent's responses, and blocks until you submit a review.
- **Cheap for the agent.** The agent writes plain Markdown and reads only what's new. There's no MCP server and no tool schemas in its context, just a skill of about 40 lines.
- **Threads, not line numbers.** Feedback is anchored to quoted text and follows it across edits. The agent declares a thread addressed and you confirm it; nothing is guessed from diffs.
- **Nothing in your repo.** ZenSpec never writes to the reviewed document. Review state lives in `~/.zenspec`.

## Install

Requires Node.js 24 or later.

```bash
npm install -g zenspec
```

From a checkout: `npm ci && npm run build && npm link`.

## The loop

The agent runs:

```bash
zenspec review docs/plans/cache.md -m "first draft"
```

The first time, this starts a local daemon (on `127.0.0.1`) and opens the plan in your browser. The command blocks until you submit a review, then prints it and exits 0. Agents should run it in the background.

On the next round, the agent edits the plan and responds to each thread in the same call:

```bash
zenspec review docs/plans/cache.md -m "write-through for sessions" \
  -r t8:edited -r t9:edited -r t11:answered:"Added a rollback section"
```

The response actions are `edited`, `answered` and `declined`. Long notes can come from YAML with `--responses-file <path|->`. `--wait 10m` returns `verdict: pending` if nobody reviews in time, so harnesses with command timeouts can simply re-run it.

### Payload

```yaml
verdict: changes_requested
review: 3
revision: 2
summary: Mostly good; caching section needs work.
threads:
  - id: t8
    kind: comment
    at: L42-44
    quote: cache invalidation via TTL only
    body: What about write-through for the session table?
  - id: t9
    kind: suggestion
    at: L60
    old: Use Redis
    new: Use Redis (managed, not self-hosted)
  - id: t10
    kind: decision
    question: db-engine
    at: L71-78
    choice: PostgreSQL
    body: but keep SQLite for tests
  - id: t13
    kind: comment
    at: L88
    quote: Pending tab
    body: The agent panel overlaps the list, see screenshot.
    images:
      - ~/.zenspec/repos/app-3f9a1c/docs/docs-plans-cache-md/attachments/9c1e0a4b2f3d.png # 1320x2248
next: zenspec review docs/plans/cache.md -r <id>:<edited|answered|declined>[:note]
```

`verdict` is always the first line. The payload contains only new and reopened threads, never the document or the history. Line numbers refer to the file as it is on disk when the review is delivered. `next:` is the exact command to run next.

## Writing plans

Plans are ordinary Markdown with GitHub extensions, math (`$…$`, `$$…$$`) and Mermaid diagrams. Decisions for the reviewer go in question callouts:

```markdown
> [!QUESTION] Which database engine? {#db-engine}
>
> - PostgreSQL (recommended)
> - SQLite
```

`[!QUESTION:MULTI]` allows several choices and `[!QUESTION:RATING]` asks for a rating. The `{#id}` is optional; by default the ID is derived from the title. Implementation steps are task-list items (`- [ ] Build the event log`).

An `.html` file is reviewed as a visual mockup in a sandboxed frame: click any element to comment on it. HTML costs the agent several times more tokens than Markdown, so keep it for UI proposals.

## Reviewing

- **Select text** to comment, suggest an exact replacement, or ask for an explanation. **Answer questions** by clicking an option. The recommended option is highlighted but never picked for you.
- **Pending review.** Everything accumulates in a server-side draft that survives reloads, daemon restarts and agent edits. Draft items whose text disappeared are marked orphaned instead of silently re-created.
- **Submit** with _Approve_, _Request changes_ or _Comment_. If questions are unanswered, you're asked once whether to leave them or accept the recommended options.
- **Threads panel.** Each thread shows the agent's response and a hint when a later revision changed its region. _Resolve_, _Reopen_ and _Reply_ take effect with your next review.
- **Revisions.** Diff any two revisions, or see what changed since your last review. Edits on disk hot-reload and show as unpublished changes until the agent publishes them.
- **Inbox** (`/inbox`) lists open reviews across all repos. Shortcuts: `c` comment on the selection, `a` submit with Approve, `z` focus mode, `Esc` close.

### Images

Paste (`Cmd+V`) or drop an image into any comment, suggestion note or reply. The browser downscales it to at most 1568 px on the long edge, and the daemon stores it under `~/.zenspec`. The agent gets the file path and dimensions and opens the image only when the text isn't enough.

## Living plans

After approval the plan becomes the implementation tracker:

- The agent ticks each step's checkbox in the file as it finishes it. The daemon records this as progress, not as a new revision, and the browser shows a progress bar and the current step.
- Any other change to an approved plan is recorded as drift and shown in a banner with the diff. You can accept it or request changes. The approval gate stays open, so implementation isn't interrupted.
- Comments you add during implementation reach Claude Code through a hook (see below), and other agents at the final review.
- When every step is done the agent runs `zenspec review <file> -m "implemented"`. Approving that review moves the plan to _done_.

## Knowledge base

When you ask for an explanation ("what is JSON?"), the answer belongs in your notes, not in the plan. Point ZenSpec at a folder of Markdown notes in `~/.zenspec/config.yaml`:

```yaml
knowledgeBase:
  root: ~/notes
  notesDir: concepts # new notes go here
  template: templates/concept.md # optional
  link: http://localhost:8080/concepts/{slug} # optional, for "Open note" links
openBrowser: true # set to false to never open the browser
daemon:
  idleMinutes: 30 # shut down after this long with no waiters and no tabs
```

If a note for the term already exists (matched by file name, `title` or `aliases`), the daemon answers the thread itself and the agent is never involved. Otherwise the payload tells the agent where to write the note and which template to follow. Known terms get a subtle underline in future plans, with the note's `summary` on hover. Without a knowledge base, explanations are answered inside the thread.

## Decision records and export

```bash
zenspec adr docs/plans/cache.md     # writes docs/adr/NNNN-<title>.md
zenspec export docs/plans/cache.md  # writes docs/plans/cache.export.html
```

`adr` writes a [MADR](https://adr.github.io/madr/)-style record of the decision threads: each question, its options, your choice and note, and the discussion. It's numbered after the ADRs already in `docs/adr/`. `export` writes one standalone HTML page with the rendered plan and its review trail: decisions, threads with their resolutions, and the revision history. CSS and math are inline; Mermaid diagrams load `mermaid` from cdn.jsdelivr.net when the page is opened. Both accept `--out <path>`.

## Agent integration

**Any agent:** install the CLI and give the agent the skill in [`skills/zenspec/SKILL.md`](skills/zenspec/SKILL.md) (or paste it into its instructions).

**Claude Code:** the plugin in [`plugins/claude-code`](plugins/claude-code/README.md) bundles the skill and two hooks. The first denies edits outside `docs/plans/` while a plan in the repo is unapproved. The second delivers comments made during implementation, and costs nothing when there are none.

```text
/plugin marketplace add egand/zenspec
/plugin install zenspec@zenspec
```

**Google Antigravity:** the plugin in [`plugins/antigravity`](plugins/antigravity) provides the skill and an always-on approval rule. Opt-in hooks are included as an example. See [`docs/harness/antigravity.md`](docs/harness/antigravity.md) for setup and what is still unverified.

```bash
agy plugin install "$(npm root -g)/zenspec/plugins/antigravity"
```

## CLI reference

| Command                                | Purpose                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `zenspec review <file> [-m] [-r]…`     | Publish, respond, wait for the next review, print it              |
| `zenspec gate [<file>] [--repo]`       | Exit 0 if approved, 1 if blocked (for hooks and CI)               |
| `zenspec status`                       | Open reviews in the current repo                                  |
| `zenspec inbox [--pending]`            | All documents, or undelivered implementation comments (for hooks) |
| `zenspec close <file>`                 | Close the review session                                          |
| `zenspec adr <file> [--out <path>]`    | Write an ADR from the decision threads                            |
| `zenspec export <file> [--out <path>]` | Write a standalone HTML export                                    |
| `zenspec daemon run\|stop\|status`     | Manage the daemon (normally started automatically)                |

`zenspec help [<command>]` is the full reference. Exit codes: 0 ok, 1 gate blocked, 2 bad arguments, 3 unknown file or session, 4 daemon unreachable, 5 daemon error. Errors go to stderr; stdout carries only the command's output.

## Development

See [AGENTS.md](AGENTS.md) for the layout and conventions, and [the architecture plan](docs/plans/zenspec-v2-architecture.md) for the design.

```bash
npm ci
npm run check   # typecheck, lint, format check, build, tests
```

## License

MIT
