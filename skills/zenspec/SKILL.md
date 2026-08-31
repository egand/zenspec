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

2. **Open the Review Session & Wait for Feedback (Default Auto-Polling)**:
   - Run `zenspec <file>` directly. It opens the browser AND automatically waits/polls for human reviewer feedback or plan approval:
     ```bash
     npx zenspec docs/plans/<topic>.md
     ```
   - For remote/container environments:
     ```bash
     npx zenspec docs/plans/<topic>.md --share
     ```
   - To launch in the background without blocking:
     ```bash
     npx zenspec docs/plans/<topic>.md --no-poll
     ```

3. **Multi-Document Workspace Review**:
   - Review all documents in a folder or repository inside a single browser instance:
     ```bash
     npx zenspec docs/plans/
     ```
   - The left sidebar provides an interactive **File Explorer** allowing the reviewer to switch between documents seamlessly.

4. **Stream Execution Telemetry (Optional)**:

   ```bash
   npx zenspec progress docs/plans/<topic>.md --step "Running test suite" --status running
   ```

5. **Wait for Human Feedback & Plan Approval (If started without `--poll`)**:

   ```bash
   npx zenspec poll docs/plans/<topic>.md
   ```

6. **Iterate on Specification (Gated Implementation)**:
   - **CRITICAL GATE**: Without explicit approval (user clicking the '✅ Approve Plan' button in the browser, returning `status: "approved"` or `approved: true`), the agent **MUST NOT START** implementing code, modifying project files, or scaffolding components.
   - The agent must continuously update the specification, answer questions, or provide clarifications based on the feedback payload (`{ startLine, endLine, selectedText, replacementText, feedback }`).
   - Use `replace_file_content` to surgically update the exact lines in `docs/plans/<topic>.md`.
   - The reviewer sees resolved questions in the **Resolved** queue section, with clickable pointers that jump to and highlight your modifications in the document canvas.
   - Reply via CLI: `zenspec poll docs/plans/<topic>.md --agent-reply "Updated Section 2 with feedback"`.
   - **Terminal Conciseness**: Keep terminal messages short and direct (1-2 sentences with links to changed lines). Do NOT duplicate or re-summarize what is already visible in the browser canvas to avoid wasting tokens.

7. **Generate Architecture Decision Record (ADR)**:

   ```bash
   npx zenspec adr docs/plans/<topic>.md
   ```

8. **Conclude Session & Proceed to Implementation**:
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
