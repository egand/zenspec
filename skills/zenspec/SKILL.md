---
name: zenspec
description: Use whenever creating, proposing, or reviewing implementation plans, architectural designs, technical RFCs, specifications, or HTML UI mockups. Launches the interactive ZenSpec browser reviewer to collect line-level feedback and plan approval before coding.
license: MIT
metadata:
  author: egand
  argument-hint: <what the plan, RFC, or UI mock should specify>
  hermes-tags: plan, implementation-plan, architecture, rfc, spec, review, markdown, html, approval, feedback
  hermes-category: productivity
---

# ZenSpec Review

ZenSpec opens Markdown or HTML documents in a browser for interactive line-level annotation, visual diagram review, and human feedback.

## Workflow

1. **Write Documentation**:
   - Write the document directly to the project's documentation directory: `docs/plans/<topic>.md`.
   - Format with standard GitHub-flavored Markdown, YAML frontmatter, KaTeX math (`$...$`), Mermaid diagrams (` ```mermaid `), or interactive question callouts (`> [!QUESTION]`, `> [!QUESTION:MULTI]`, `> [!QUESTION:RATING]`).

2. **Open the Review Session & Wait for Feedback (Mandatory Polling)**:
   - Run `zenspec <file>` directly. It opens the browser AND automatically waits/polls for human reviewer feedback or plan approval. When feedback or approval arrives, it outputs the JSON payload to stdout and exits with code 0:
     ```bash
     npx zenspec docs/plans/<topic>.md
     ```
   - For remote/container environments:
     ```bash
     npx zenspec docs/plans/<topic>.md --share
     ```

   > [!TIP]
   > **Agent Execution Pattern (Harness-Agnostic)**:
   >
   > - **Background / Async Tasks**: If your agent platform supports background command execution or async tasks, launch `zenspec` in the background and end your turn. The harness will automatically wake you up when the process finishes with the reviewer's feedback. Do NOT busy-poll or sleep in a loop.
   > - **MCP Tools**: If your environment has ZenSpec MCP tools available, call `zen_open_review` with `{"filePath": "docs/plans/<topic>.md"}` to wait for reviewer response natively over JSON-RPC.
   > - **Synchronous Shells**: If your platform only runs synchronous CLI commands, allow `zenspec` to wait for the human reviewer without aborting or timing out early.

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

5. **Continue Polling After Modifying Specification**:

   ```bash
   npx zenspec poll docs/plans/<topic>.md --agent-reply "Updated based on feedback"
   ```

6. **Iterate on Specification (Live Hot Reload & Gated Implementation)**:
   - **CRITICAL GATE**: Without explicit approval (user clicking the '✅ Approve Plan' button in the browser, returning `status: "approved"` or `approved: true`), the agent **MUST NOT START** implementing code, modifying project files, or scaffolding components.
   - The agent must continuously update the specification, answer questions, or provide clarifications based on the feedback payload (`{ startLine, endLine, selectedText, replacementText, feedback }`).
   - Use `replace_file_content` to surgically update the exact lines in `docs/plans/<topic>.md`.
   - **⚡ Live Hot Reloading**: Whenever you edit a file on disk, the browser automatically re-renders in place via Server-Sent Events, preserving the reviewer's scroll position and highlighting modified lines without needing a manual refresh or restarting `zenspec`.
   - **Resolved Feedback Pointers**: The reviewer sees addressed questions in the **Resolved** queue section, with **📍 Jump & Highlight** buttons that smoothly scroll to and illuminate your modifications with a glowing pulse animation.
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
