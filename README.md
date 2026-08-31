# 🧘 ZenSpec

> **Minimalist, token-efficient Agent Experience Interface (AXI) and interactive browser reviewer for Markdown & HTML artifacts.**

---

## ⚡ What is ZenSpec?

AI coding agents are great at creating architecture plans, technical specifications, and UI prototypes. However, the human-in-the-loop review process is often fragmented:

- Explaining changes in long chat messages is slow and burns tokens.
- Taking screenshots loses interactivity.
- Writing full HTML boilerplate for everyday documents wastes 70%+ of agent tokens.

**ZenSpec** solves this by providing a lightweight, local-first review loop:

- 📝 **Markdown-First**: Write clean, token-efficient Markdown in your repo (`docs/plans/spec.md`).
- ⚡ **Instant In-Memory Rendering**: KaTeX math ($E=mc^2$), Mermaid diagrams, and Markmap mindmaps render in `< 15ms` with zero build steps.
- 🎯 **Line-Anchored Annotation**: Highlighting text in the browser captures exact Markdown line numbers (`lines: [14, 18]`), allowing the agent to make deterministic, surgical edits.
- 🎨 **Dual-Mode Expressiveness**: Also supports raw `.html` files in sandboxed iframes when building rich interactive UI mocks.
- 🤖 **Agent-Native Protocol**: CLI long-polling (`zenspec poll`) with live agent presence indicators.

---

## 🚀 Quick Start

### 1. Zero-Install with NPX

Any capable agent can run `zenspec` with nothing pre-installed:

```bash
npx zenspec docs/plans/architecture.md
```

### 2. Global Installation

```bash
npm install -g zenspec
```

---

## 🛠️ CLI Reference

| Command                          | Description                                                        |
| :------------------------------- | :----------------------------------------------------------------- |
| `zenspec <file\|dir>`            | Start daemon and open interactive review session in browser        |
| `zenspec poll <file>`            | Long-poll until human submits feedback or ends session             |
| `zenspec approve <file>`         | Approve plan & authorize agent to proceed with implementation      |
| `zenspec reply <file> -m "..."`  | Push agent progress/chat message to the browser conversation       |
| `zenspec progress <file> --step` | Stream live execution status (testing, patching) to browser topbar |
| `zenspec adr <file> [--out]`     | Generate MADR Architecture Decision Record from review decisions   |
| `zenspec mcp`                    | Run native Model Context Protocol (MCP) server over stdio          |
| `zenspec end <file>`             | Conclude review session as agent                                   |
| `zenspec export <file>`          | Export standalone portable HTML with inlined styles and scripts    |
| `zenspec status`                 | List active review sessions                                        |
| `zenspec stop`                   | Stop local background daemon                                       |

### Flags

- `--share`: Launch secure remote sharing tunnel for GitHub Codespaces, remote containers, or LAN collaboration.
- `--no-open`: Register and serve session without launching the default browser.
- `--port <number>`: Specify custom port (default: `4388`).
- `--agent-reply "<msg>"`: Attach agent reply when polling.

---

## ⚡ Highlights & Key Features

### 1. Ghost Diffs & Change Tracking

When an agent edits the reviewed Markdown file on disk, `zenspec` computes line diffs and renders clean visual gutter diff indicators directly in the browser canvas.

### 2. Suggest Edit Mode

Reviewers can highlight any text and click **Suggest Edit** to provide proposed replacement text. The agent receives `{ startLine, endLine, selectedText, replacementText }` for instant, one-call application via `replace_file_content`.

### 3. Plan & Artifact Approval Gate (✅ Approve Plan)

The UI includes a dedicated **Approve Plan** button (`a` shortcut). Without clicking this approval button (`approved: true` or `status: 'approved'`), agents **MUST NOT** start implementing things. The agent is required to keep iterating on the specification, answering questions, and providing further details until the human grants explicit approval.

### 4. Native Model Context Protocol (MCP) Server

Integrate with Claude Desktop, Cursor, Antigravity, or Windsurf via `zenspec mcp`:

```json
{
  "mcpServers": {
    "zenspec": {
      "command": "zenspec",
      "args": ["mcp"]
    }
  }
}
```

### 4. Interactive Callouts & Ratings

- Single Choice: `> [!QUESTION] Which database should we use?`
- Multi-Select: `> [!QUESTION:MULTI] Which modules to enable?`
- Rating Scale: `> [!QUESTION:RATING] Rate the caching strategy`

### 5. Automated ADR Generator (`zenspec adr`)

Instantly turn completed review conversations and selected decision cards into standard MADR (Markdown Architectural Decision Records) in `docs/adr/`.

---

## 🔄 The Review Loop

```
┌────────────────────────────────┐
│ 1. Agent writes plan.md        │
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 2. zenspec docs/plans/plan.md  │ (Opens browser at localhost:4388)
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 3. Human highlights text /     │
│    suggests edits & decisions  │
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 4. zenspec poll plan.md        │ (Returns { lines: [14, 16], replacementText })
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 5. Agent updates lines 14-16   │
│    -> Browser live-reloads!    │
└────────────────────────────────┘
```

---

## 🧩 Agent Skill

Install the ZenSpec skill for Claude Code, Antigravity, or Codex:

```bash
npx skills add egand/zenspec --skill zenspec
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
