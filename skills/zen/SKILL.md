---
name: zen
description: Create reviewable Markdown documentation (plans, RFCs, specs) or HTML UI mocks with real-time interactive browser annotation using the zen-axi CLI.
license: MIT
metadata:
  author: egand
  argument-hint: <what the plan or document should specify>
  hermes-tags: markdown, html, review, artifacts, visualization
  hermes-category: productivity
---

# Zen Review

Zen opens Markdown or HTML documents in a browser for interactive line-level annotation, visual diagram review, and human feedback.

## Workflow

1. **Write Documentation**:
   - Write the document directly to the project's documentation directory: `docs/plans/<topic>.md`.
   - Format with standard GitHub-flavored Markdown, KaTeX math (`$...$`), Mermaid diagrams (` ```mermaid `), or interactive question callouts (`> [!QUESTION]`).

2. **Open the Review Session**:

   ```bash
   npx zen-axi docs/plans/<topic>.md
   ```

3. **Wait for Human Feedback**:

   ```bash
   npx zen-axi poll docs/plans/<topic>.md
   ```

4. **Apply Surgical Line Updates**:
   - The poll command returns `{ startLine, endLine, selectedText, feedback }`.
   - Use `replace_file_content` to surgically update the exact lines in `docs/plans/<topic>.md`.
   - Reply via CLI: `zen-axi poll docs/plans/<topic>.md --agent-reply "Updated Section 2 with feedback"`.
   - **Terminal Conciseness**: Keep terminal messages short and direct (1-2 sentences with links to changed lines). Do NOT duplicate or re-summarize what is already visible in the browser canvas to avoid wasting tokens.

5. **Conclude Session**:
   - When the user is satisfied, run:
   ```bash
   npx zen-axi end docs/plans/<topic>.md
   ```
   - The `.md` file remains in `docs/plans/` ready for `git commit` as permanent project documentation.
