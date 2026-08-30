# Zen AXI Architecture Plan

A minimalist, high-performance review system for Markdown documentation.

## 1. System Overview

The system consists of three primary components:

1. **CLI Layer**: Single-bundle executable communicating with the local daemon.
2. **Server Daemon**: Fast, in-memory state manager with long-polling coordination.
3. **Browser Client**: In-memory Markdown compiler with source line anchoring.

```mermaid
sequenceDiagram
  autonumber
  actor Human
  participant Browser
  participant Daemon
  participant Agent

  Agent->>Daemon: zen-axi poll plan.md (long-poll)
  Human->>Browser: Highlight line 14 & add comment
  Browser->>Daemon: POST /api/prompts
  Daemon-->>Agent: Returns { lines: [14, 14], feedback }
  Agent->>Agent: replace_file_content(lines 14-14)
  Daemon->>Browser: SSE reload event (15ms)
```

## 2. Interactive Questions

> [!QUESTION] Which default storage backend should we use for long-term state persistence?
>
> - [x] In-Memory Map with JSON snapshot fallback
> - [ ] SQLite embedded database
> - [ ] Redis cache

## 3. Mathematical Foundations

The token reduction efficiency factor $\eta$ is defined as:
$$\eta = 1 - \frac{\text{Tokens}_{\text{Markdown}}}{\text{Tokens}_{\text{HTML}}} \approx 0.72$$
