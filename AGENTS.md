# AGENTS.md

Guidance and standards for AI coding agents working on `zen-axi`.

## Project Overview

`zen-axi` is a minimalist, token-efficient Agent Experience Interface (AXI) and browser reviewer for Markdown documentation (`docs/plans/*.md`) and rich HTML artifacts.

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
4. **Dual-Mode**: Raw `.html` artifacts are seamlessly supported in sandboxed iframes for rich UI prototypes.
5. **Clean Git Source**: Third-party runtime dependencies are managed via `package.json` and bundled into `dist/` during `npm run build`. No raw vendor JavaScript files are committed to Git.
