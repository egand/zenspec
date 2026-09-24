# ZenSpec plugin for Claude Code

Adds three things to Claude Code:

- **Skill** `zenspec` (`skills/zenspec/SKILL.md`): write the plan, run the `zenspec review` loop, and wait for approval.
- **Approval gate** (`PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit`): while any review in the edited file's repo is unapproved, edits outside `docs/plans/` (and outside the reviewed documents) are denied with a one-line reason.
- **Implementation comments** (`PostToolUse` on edits and `Bash`): comments the reviewer adds to an approved plan reach Claude as additional context, once each. When there are none, the hook prints nothing and costs no tokens.

Both hooks run `hooks/zenspec-hook.mjs` (Node built-ins only). They fail open: when `zenspec` isn't installed or no daemon is running, they allow the edit and print nothing. The pre hook never starts the daemon. The post hook starts it in the background when none is running and the repo has an approved or implementing plan, so checked steps and drift keep being tracked; the daemon then stays up until that plan is done.

## Requirements

- Node.js 24 or later.
- The `zenspec` CLI on `PATH`: `npm install -g zenspec`. Set `ZENSPEC_BIN` to use another binary. A path ending in `.mjs` or `.js` runs under Node.

## Install

**Try it for one session** (loads the plugin in place):

```bash
claude --plugin-dir "$(npm root -g)/zenspec/plugins/claude-code"
```

**Install from the marketplace.** The repo root has `.claude-plugin/marketplace.json`, so the repo itself is a marketplace:

```text
/plugin marketplace add egand/zenspec
/plugin install zenspec@zenspec
```

You can also add a local checkout: `/plugin marketplace add /path/to/zenspec`.

Run `/reload-plugins` or restart Claude Code after an update. Run `/hooks` to confirm that both hooks are registered.

## How the hooks answer

| Situation                                             | Output                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Edit while a plan in the repo is unapproved           | exit 0 with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`     |
| Edit allowed, or zenspec or the daemon is unavailable | exit 0, no output (normal permission flow)                                                                                         |
| New reviewer comments on an approved plan             | exit 0 with `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Reviewer comments on the approved plan…"}}` |
| Nothing pending                                       | exit 0, no output                                                                                                                  |

The PostToolUse hook runs `zenspec inbox --pending` (which marks comments as delivered) only when an approved plan in the repo has a review it hasn't seen yet. It keeps a small cache of the reviews it has seen in `${CLAUDE_PLUGIN_DATA}` (or the OS temp directory). In every other case it takes about 50 ms.

The canonical skill lives at `skills/zenspec/SKILL.md` in the package root. The copy here is kept identical by a test.

Formats: [plugins reference](https://code.claude.com/docs/en/plugins-reference), [hooks reference](https://code.claude.com/docs/en/hooks), [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).
