# AGENTS.md

Guidance for agents working on the ZenSpec codebase. The design is in [docs/plans/zenspec-v2-architecture.md](docs/plans/zenspec-v2-architecture.md) (section numbers below refer to it). Read the relevant section before changing behavior.

## Commands

Node 24 or later, npm, pure ESM.

```bash
npm ci
npm run check        # typecheck, lint, format check, build, tests: must exit 0 before you finish
npm test             # builds first (pretest), then vitest run
npx vitest run tests/core        # one suite
npm run build        # dist/cli.mjs (CLI + daemon) and dist/client/ (browser bundle)
npm run format       # prettier --write .
```

Run the CLI from a build with `node dist/cli.mjs <command>`. Set `ZENSPEC_HOME` to a temp directory to keep your experiments out of `~/.zenspec`.

## Layout

```text
src/
  core/     pure domain: types, events, reducer, parser, anchoring, diff, payload formatter,
            API contract (api.ts), ADR and HTML export renderers
  daemon/   HTTP routes, SSE, file watching, event-log storage, knowledge-base index
  cli/      one module per command in cli/commands/; talks to the daemon over HTTP only
  client/   Preact + signals browser app (app/ shell, doc/ document view, review/ panel, store/)
skills/zenspec/SKILL.md      the agent skill (canonical copy)
plugins/claude-code/         Claude Code plugin: skill copy, hooks, manifest
plugins/antigravity/         Antigravity plugin: skill copy, rule, example hooks
scripts/build.ts             esbuild for the CLI bundle and the client bundle
tests/                       mirrors src/: core, daemon, cli, client, e2e, plugins
```

**Dependency rule:** `core` ← `daemon`, `cli`, `client`. `core` imports nothing that does I/O (no `node:*`, `fs`, `http`, `chokidar`, `open`, …) and nothing from the other layers. ESLint enforces this. `cli` talks to the daemon only over HTTP; its one import of `daemon` is `zenspec daemon run`, which hosts the daemon in its own process. `client` never imports `daemon` or `cli`: they share types and logic only through `core`.

## Invariants

- **The daemon is the only writer** of `~/.zenspec`. The CLI and the browser go through the HTTP API in `src/core/api.ts`. Never open or write the event log, drafts or attachments from the CLI.
- **State is derived, never stored.** The event log (`events.jsonl`) is append-only. Current state comes from the pure `replay(events)` in `core/reducer.ts`, which the daemon and the browser share. New behavior means a new event or a reducer rule, not a mutable field. Bump `EVENT_SCHEMA_VERSION` for breaking event changes.
- **Core is pure.** Same input, same output: no clocks, randomness, I/O or globals. Pass timestamps and file contents in as arguments.
- **Never write to the reviewed document.** Suggestions reach the agent as exact `old`/`new` strings for it to apply. `adr` and `export` write new files only.
- **CLI stdout is only the command's output:** the YAML payload for `review`, the written path for `adr` and `export`, and so on. Diagnostics go to stderr with a non-zero exit code (see `cli/errors.ts`). `review` exits 0 for any delivered review; the verdict is on the first payload line.
- **The payload budget is tested** (§3, `tests/core/budget.test.ts`). Payloads contain only what's new, are plain UTF-8 (never HTML-escaped), and keep `verdict` first. Anything that adds tokens to the payload, the skill or `zenspec help` needs a reason, and the budget tests must still pass.
- **Resolution is declared, not inferred.** The agent responds (`edited`, `answered`, `declined`) and the reviewer resolves. The "likely addressed" hint is display-only and never changes a status.
- **The skill stays short** (about 40 lines). Details belong in `zenspec help`. The copies under `plugins/` must match `skills/zenspec/SKILL.md` (a test checks this).
- The daemon binds to `127.0.0.1` only and rejects cross-origin requests.

## Tests

- Vitest, in `tests/` mirroring `src/`. Name tests after behavior (`"keeps a draft across reloads"`), not after functions.
- **core:** plain unit tests on hand-built events and documents. No mocks needed: it's pure.
- **daemon:** real HTTP against an in-process daemon on a temp `ZENSPEC_HOME` and a temp git repo (`tests/daemon/helpers.ts`).
- **cli:** commands run through `runCli` with a fake context and a stub daemon (`tests/cli/harness.ts`).
- **e2e:** `tests/e2e/protocol.test.ts` spawns the built `dist/cli.mjs` as the agent, lets it auto-start the real daemon, and acts as the reviewer over HTTP. It checks that no daemon process is left behind.
- **client:** components and stores under `happy-dom` (`// @vitest-environment happy-dom`). No real browser is needed, and none is used in CI.
- No `setTimeout` sleeps to wait for things: use `vi.waitFor` or an explicit signal. Use temp directories and never touch the real `~/.zenspec`.
- `tests/global-setup.ts` rebuilds `dist/` when sources are newer, so e2e tests never run a stale build.

For UI changes, also check the result in a real browser (`node dist/cli.mjs review <file>` with a temp `ZENSPEC_HOME`). Keep screenshots out of git.
