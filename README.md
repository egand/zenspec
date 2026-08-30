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

| Command                         | Description                                                     |
| :------------------------------ | :-------------------------------------------------------------- |
| `zen-axi <file.md\|file.html>`  | Start background daemon and open interactive review in browser  |
| `zen-axi poll <file>`           | Long-poll until human submits feedback or ends session          |
| `zen-axi reply <file> -m "..."` | Push agent progress/chat message to the browser conversation    |
| `zen-axi end <file>`            | Conclude review session as agent                                |
| `zen-axi export <file>`         | Export standalone portable HTML with inlined styles and scripts |
| `zen-axi status`                | List active review sessions                                     |
| `zen-axi stop`                  | Stop local background daemon                                    |

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
│    answers interactive options │
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ 4. zen-axi poll plan.md        │ (Returns { lines: [14, 16], feedback })
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
npm run check          # Run full verification pipeline
```

---

## 📄 License

MIT © 2026 egand
