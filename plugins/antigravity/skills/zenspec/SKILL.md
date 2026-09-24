---
name: zenspec
description: Use before implementing any non-trivial change. Write the plan, spec, RFC, or UI mockup as a doc in docs/plans/ and get human review and approval with `zenspec review` before coding.
---

# ZenSpec

Use for plans, specs, RFCs, and UI mockups that a human should approve before you implement.

## Write

Write Markdown in `docs/plans/<topic>.md`. Put each decision the reviewer must make in a callout:

```markdown
> [!QUESTION] Which database?
>
> - **(Recommended) PostgreSQL**: ACID, managed.
> - SQLite: embedded.
```

`[!QUESTION:MULTI]` allows several choices, `[!QUESTION:RATING]` a rating. List implementation steps as `- [ ]` checkboxes.
Write HTML only for a visual UI mockup: it costs several times more tokens than Markdown.

## Review loop

1. `zenspec review <file> -m "<what changed>"`. It blocks until the reviewer submits, so run it in the background (it wakes you when it exits) and end your turn.
2. Read the YAML. For each thread: apply `old` → `new` suggestions verbatim, address comments, and use `choice` for decisions. Open `images` only if the text is not enough.
3. Respond on the next run: `zenspec review <file> -m "..." -r t3:edited -r t4:answered:"<answer>" -r t5:declined:"<why>"`.
4. `explain` threads: write the note at `save_to` following `template`, then respond `-r <id>:answered:"<one-line summary>"`.
5. Repeat. The `next:` line in the payload is the exact command to run next. `verdict: pending` means just re-run it.

## Gate

Never implement anything before the payload says `verdict: approved`. Until then, edit only the plan.

## After approval

- Tick each step's checkbox (`- [ ]` → `- [x]`) in the plan as you finish it. Don't change other plan content without saying why.
- When every step is done: `zenspec review <file> -m "implemented"`, then handle that review as above.

Run `zenspec help` for the full reference.
