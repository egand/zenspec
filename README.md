# 🧘 Zen AXI

> **Minimalist, token-efficient Agent Experience Interface (AXI) and interactive browser reviewer for Markdown & HTML artifacts.**

---

## ⚡ What is Zen AXI?

AI coding agents are great at creating architecture plans, technical specifications, and UI prototypes. However, the human-in-the-loop review process is often fragmented:

- Explaining changes in long chat messages is slow and burns tokens.
- Taking screenshots loses interactivity.
- Writing full HTML boilerplate for everyday documents wastes 70%+ of agent tokens.

**Zen AXI** solves this by providing a lightweight, local-first review loop:

- 📝 **Markdown-First**: Write clean, token-efficient Markdown in your repo (`docs/plans/spec.md`).
- ⚡ **Instant In-Memory Rendering**: KaTeX math ($E=mc^2$), Mermaid diagrams, and Markmap mindmaps render in `< 15ms` with zero build steps.
- 🎯 **Line-Anchored Annotation**: Highlighting text in the browser captures exact Markdown line numbers (`lines: [14, 18]`), allowing the agent to make deterministic, surgical edits.
- 🎨 **Dual-Mode Expressiveness**: Also supports raw `.html` files in sandboxed iframes when building rich interactive UI mocks.
- 🤖 **Agent-Native Protocol**: CLI long-polling (`zen-axi poll`) with live agent presence indicators.

---

## 🚀 Quick Start

### 1. Zero-Install with NPX

Any capable agent can run `zen-axi` with nothing pre-installed:

```bash
npx zen-axi docs/plans/architecture.md
```

### 2. Global Installation

```bash
npm install -g zen-axi
```

---

## 🛠️ CLI Reference

| Command                          | Description                                                        |
| :------------------------------- | :----------------------------------------------------------------- |
| `zen-axi <file\|dir>`            | Start daemon and open interactive review session in browser        |
| `zen-axi poll <file>`            | Long-poll until human submits feedback or ends session             |
| `zen-axi reply <file> -m "..."`  | Push agent progress/chat message to the browser conversation       |
| `zen-axi progress <file> --step` | Stream live execution status (testing, patching) to browser topbar |
| `zen-axi adr <file> [--out]`     | Generate MADR Architecture Decision Record from review decisions   |
| `zen-axi mcp`                    | Run native Model Context Protocol (MCP) server over stdio          |
| `zen-axi end <file>`             | Conclude review session as agent                                   |
| `zen-axi export <file>`          | Export standalone portable HTML with inlined styles and scripts    |
| `zen-axi status`                 | List active review sessions                                        |
| `zen-axi stop`                   | Stop local background daemon                                       |

### Flags

- `--share`: Launch secure remote sharing tunnel for GitHub Codespaces, remote containers, or LAN collaboration.
- `--no-open`: Register and serve session without launching the default browser.
- `--port <number>`: Specify custom port (default: `4388`).
- `--agent-reply "<msg>"`: Attach agent reply when polling.

---

## ⚡ Highlights & Key Features

### 1. Ghost Diffs & Change Tracking

When an agent edits the reviewed Markdown file on disk, `zen-axi` computes line diffs and renders clean visual gutter diff indicators directly in the browser canvas.

### 2. Suggest Edit Mode

Reviewers can highlight any text and click **Suggest Edit** to provide proposed replacement text. The agent receives `{ startLine, endLine, selectedText, replacementText }` for instant, one-call application via `replace_file_content`.

### 3. Native Model Context Protocol (MCP) Server

Integrate with Claude Desktop, Cursor, Antigravity, or Windsurf via `zen-axi mcp`:

```json
{
  "mcpServers": {
    "zen-axi": {
      "command": "zen-axi",
      "args": ["mcp"]
    }
  }
}
```

### 4. Interactive Callouts & Ratings

- Single Choice: `> [!QUESTION] Which database should we use?`
- Multi-Select: `> [!QUESTION:MULTI] Which modules to enable?`
- Rating Scale: `> [!QUESTION:RATING] Rate the caching strategy`

### 5. Automated ADR Generator (`zen-axi adr`)

Instantly turn completed review conversations and selected decision cards into standard MADR (Markdown Architectural Decision Records) in `docs/adr/`.

---

## 🔄 The Review Loop

```
┌────────────────────────────────┐
│ 1. Agent writes plan.md        │
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 2. zen-axi docs/plans/plan.md  │ (Opens browser at localhost:4388)
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 3. Human highlights text /     │
│    suggests edits & decisions  │
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 4. zen-axi poll plan.md        │ (Returns { lines: [14, 16], replacementText })
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 5. Agent updates lines 14-16   │
│    -> Browser live-reloads!    │
└────────────────────────────────┘
```

---

## 🧩 Agent Skill

Install the Zen skill for Claude Code, Antigravity, or Codex:

```bash
npx skills add egand/zen-axi --skill zen
```

---

## 🧪 Development

```bash
npm install
npm run build          # Compile CLI and client bundle
npm test               # Run Vitest test suite
npm run check          # Run full verification pipeline (lint, typecheck, format, test, build)
```

---

## 📄 License

MIT © 2026 egand
