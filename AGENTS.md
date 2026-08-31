# AGENTS.md

Guidance and standards for AI coding agents working on `zenspec`.

## Project Overview

`zenspec` is a minimalist, token-efficient Agent Experience Interface (AXI) and browser reviewer for Markdown documentation (`docs/plans/*.md`) and rich HTML artifacts.

## Pinned Runtime & Commands

- **Node.js**: >= 24 LTS (`.node-version`, `mise.toml`)
- **Package Manager**: `npm` / `pnpm`
- **Module System**: Pure ESM (`"type": "module"`)

```bash
npm run check           # Run typecheck, lint, format check, tests, and build
npm test                # Run Vitest test suite
npm run build           # Compile TypeScript to dist/cli.mjs and dist/client/
npm run typecheck       # tsc --noEmit
npm run lint            # ESLint over src, tests, scripts
npm run format:check    # Prettier validation
```

## Architectural Invariants

1. **Markdown-First**: Markdown files (`.md`) are the primary source of truth for architectural plans, specifications, and notes. They are stored permanently in project repositories (e.g. `docs/plans/`).
2. **In-Memory Rendering**: The browser client parses Markdown to HTML dynamically in memory with `data-line-start` and `data-line-end` attributes. No intermediate HTML files are written to disk during live review.
3. **Surgical Line-Based Feedback**: Long-polling (`GET /api/poll`) delivers `{ startLine, endLine, feedback }` payloads so agents can apply direct line replacements (`replace_file_content`) without scanning or rewriting full files.
4. **Plan & Artifact Approval Gate**: Without clicking the '✅ Approve Plan' button in the browser (or receiving `status: "approved"` / `approved: true`), the agent **MUST NOT START** implementing features, modifying source code, or scaffolding files. The agent must strictly keep updating the spec, answering review questions, and providing further details.
5. **Dual-Mode**: Raw `.html` artifacts are seamlessly supported in sandboxed iframes for rich UI prototypes.
6. **Clean Git Source**: Third-party runtime dependencies are managed via `package.json` and bundled into `dist/` during `npm run build`. No raw vendor JavaScript files are committed to Git.
7. **Live In-Memory Hot Reloading**: File edits on disk automatically trigger instant in-place re-rendering via Server-Sent Events (`ServerEvent.Reload`) while preserving reviewer scroll positions and highlighting modified lines.
8. **Multi-Document File Explorer**: Projects with multiple `.md` / `.html` files are reviewed in a single browser session with the Left File Explorer.
9. **Resolved Feedback Tracking**: All addressed reviewer items transition to the Resolved queue section with interactive jump pointers that highlight agent modifications on the document canvas.

## UI Verification & Screenshot Standards

- **Visual Quality & Pixel Perfection**: When developing or refactoring UI components (`src/client/`), agents must verify the rendered output in a browser to ensure layout fidelity.
- **Pull Request Proof**: Visual proof (screenshots or recordings) should be attached as artifacts when submitting pull requests for UI changes or completing visual milestones.
- **Zero-Bloat Automated Tests**: Automated CI test suites (`tests/e2e-browser.test.ts`) must execute in-memory DOM assertions without saving binary image files to disk. Temporary visual captures are generated on-demand as PR artifacts and kept out of git history.
