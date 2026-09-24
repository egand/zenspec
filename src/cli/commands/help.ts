/** `zenspec help [cmd]`: the authoritative reference agents read on demand. Keep it short. */
import { positionals, parse } from "../args.js";
import type { CliContext } from "../context.js";
import { usageError } from "../errors.js";

const EXIT_CODES = `Exit codes: 0 ok, 1 gate blocked, 2 bad arguments, 3 unknown file or session, 4 daemon unreachable, 5 daemon error. Errors go to stderr.`;

export const HELP: Record<string, string> = {
  review: `zenspec review <file> [-m <summary>] [-r <id>:<action>[:<note>]]... [--responses-file <path|->] [--wait <duration>] [--no-open]

Publish <file> as a new revision if it changed, record responses, open the browser the first
time, then block until the next review and print it as YAML on stdout (exit 0).
  -m <summary>             revision summary
  -r <id>:<action>[:note]  respond to a thread; action is edited|answered|declined; repeatable;
                           the note may contain colons
  --responses-file <path>  YAML list of {thread, action, note}; "-" reads stdin
  --wait <duration>        give up after 30s|10m|1h and print "verdict: pending" (exit 0);
                           re-run the printed next: command to keep waiting
  --no-open                never open the browser
Every waiting process receives the same review. Prefer running it in the background.
Re-running with no changes and no responses just resumes waiting.
Payload: verdict, review, revision, summary, threads (id, kind, at, quote, body, old/new,
choice, images), next (the exact command to run next).`,
  gate: `zenspec gate [<file>] [--repo]

<file>             exit 0 if the document is approved, else 1 with the reason on stderr
--repo [<file>]    exit 1 while any review in the repo (of <file>, else the cwd) is unapproved;
                   editing a reviewed document or anything under docs/plans/ stays allowed`,
  close: `zenspec close <file>

Close the review session for <file>. Prints nothing.`,
  status: `zenspec status

One line per open review in the current repo: path, phase, revision, verdict, open threads, URL.`,
  inbox: `zenspec inbox [--pending]

Without flags: every document across repos, one line each.
--pending  comments made during implementation not yet delivered, as "# <path>" plus YAML;
           marks them delivered; prints nothing when there are none (for hooks)`,
  daemon: `zenspec daemon run|stop|status

run     run the daemon in the foreground (started automatically by other commands)
stop    stop the running daemon
status  print pid, port, and version; exit 4 when not running`,
  adr: `zenspec adr <file> [--out <path>]

Write a MADR-style Architecture Decision Record from the document's decision threads (the
reviewer's answers to [!QUESTION] blocks, their notes, and the agent's responses). Default
output: docs/adr/NNNN-<slug>.md in the repo, numbered after the existing ADRs. Prints the
written path; exit 3 when the document has no decision threads.`,
  export: `zenspec export <file> [--out <path>]

Write a standalone HTML page: the document plus its review trail (decisions, threads with
their resolutions, history). CSS and math are inline; Mermaid diagrams load mermaid from
cdn.jsdelivr.net when opened. Default output: <file>.export.html next to the file. Prints
the written path.`,
  help: `zenspec help [<command>]

Show this reference, or one command's.`,
};

export const USAGE = `usage: zenspec <command> [args]
commands: ${Object.keys(HELP).join(", ")}
run "zenspec help <command>" for details`;

export function help(args: string[], ctx: CliContext): void {
  const [name] = positionals(parse(args, {}).positionals, 0, 1, "zenspec help [<command>]");
  if (name === undefined) {
    ctx.stdout.write(`${Object.values(HELP).join("\n\n")}\n\n${EXIT_CODES}\n`);
    return;
  }
  const text = HELP[name];
  if (!text) throw usageError(`unknown command: ${name}\n${USAGE}`);
  ctx.stdout.write(`${text}\n\n${EXIT_CODES}\n`);
}
