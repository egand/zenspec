---
name: zenspec
description: Create reviewable Markdown documentation (plans, RFCs, specs) or HTML UI mocks with real-time interactive browser annotation using the zenspec CLI.
license: MIT
metadata:
  author: egand
  argument-hint: <what the plan or document should specify>
  hermes-tags: markdown, html, review, artifacts, visualization, spec, axi
  hermes-category: productivity
---

# ZenSpec Review

ZenSpec opens Markdown or HTML documents in a browser for interactive line-level annotation, visual diagram review, and human feedback.

## Workflow

1. **Write Documentation**:
   - Write the document directly to the project's documentation directory: `docs/plans/<topic>.md`.
   - Format with standard GitHub-flavored Markdown, YAML frontmatter, KaTeX math (`$...$`), Mermaid diagrams (` ```mermaid `), or interactive question callouts (`> [!QUESTION]`, `> [!QUESTION:MULTI]`, `> [!QUESTION:RATING]`).

2. **Open the Review Session**:

   ```bash
   npx zenspec docs/plans/<topic>.md
   # Or for remote/container environments:
   npx zenspec docs/plans/<topic>.md --share
   ```

3. **Stream Execution Telemetry (Optional)**:

   ```bash
   npx zenspec progress docs/plans/<topic>.md --step "Running test suite" --status running
   ```

4. **Wait for Human Feedback & Plan Approval**:

   ```bash
   npx zenspec poll docs/plans/<topic>.md
   ```

5. **Iterate on Specification (Gated Implementation)**:
   - **CRITICAL GATE**: Without explicit approval (user clicking the '✅ Approve Plan' button in the browser, returning `status: "approved"` or `approved: true`), the agent **MUST NOT START** implementing code, modifying project files, or scaffolding components.
   - The agent must continuously update the specification, answer questions, or provide clarifications based on the feedback payload (`{ startLine, endLine, selectedText, replacementText, feedback }`).
   - Use `replace_file_content` to surgically update the exact lines in `docs/plans/<topic>.md`.
   - Reply via CLI: `zenspec poll docs/plans/<topic>.md --agent-reply "Updated Section 2 with feedback"`.
   - **Terminal Conciseness**: Keep terminal messages short and direct (1-2 sentences with links to changed lines). Do NOT duplicate or re-summarize what is already visible in the browser canvas to avoid wasting tokens.

6. **Generate Architecture Decision Record (ADR)**:

   ```bash
   npx zenspec adr docs/plans/<topic>.md
   ```

7. **Conclude Session & Proceed to Implementation**:
   - Once the plan is approved, conclude the review session:
   ```bash
   npx zenspec end docs/plans/<topic>.md
   ```
   - The `.md` file remains in `docs/plans/` ready for `git commit` as permanent project documentation.

## MCP Protocol Integration

For LLM harnesses with Model Context Protocol (MCP) support:

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
