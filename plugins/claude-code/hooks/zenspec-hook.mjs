#!/usr/bin/env node
/**
 * ZenSpec harness hook (plan §10, §14). Self-contained: Node built-ins only.
 *
 *   node zenspec-hook.mjs pre                     Claude Code PreToolUse (Edit|Write|MultiEdit|NotebookEdit)
 *   node zenspec-hook.mjs post                    Claude Code PostToolUse
 *   node zenspec-hook.mjs antigravity-pre         Antigravity PreToolUse (experimental)
 *   node zenspec-hook.mjs antigravity-invocation  Antigravity PostInvocation (experimental)
 *
 * Reads the hook JSON on stdin. Always fails open: when zenspec, the daemon, or the input is
 * unavailable it exits 0 without output, so editing is never bricked. Silent when allowed.
 * When no daemon runs but the repo has an approved or implementing plan, the post hooks start
 * one in the background, so checked steps and drift keep being tracked (§10).
 * `ZENSPEC_BIN` overrides the `zenspec` executable (a `.js`/`.mjs` path runs under Node).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HTTP_TIMEOUT_MS = 500;
const CLI_TIMEOUT_MS = 5000;
const BLOCK_ADVICE = "Edit only the plan until `zenspec review` returns verdict: approved.";
const COMMENTS_HEADER = "Reviewer comments on the approved plan (address them, then continue):";

const mode = process.argv[2];
let output;
try {
  output = await run(mode, await readInput());
} catch {
  // Fail open.
}
// Exit explicitly once stdout is flushed: a failed spawn can leave its timeout timer pending.
process.stdout.write(output ? JSON.stringify(output) + "\n" : "", () => process.exit(0));

async function run(mode, input) {
  if (mode === "pre" || mode === "antigravity-pre") {
    const antigravity = mode === "antigravity-pre";
    const cwd = workingDir(input);
    const target = antigravity
      ? pickPath(input.toolCall?.args)
      : pickPath(input.tool_input, ["file_path", "notebook_path"]);
    if (!target) return undefined;
    const file = path.resolve(cwd, target);
    // Cheap read-only pre-check; the CLI decides the exemptions (the plan files).
    const gate = await daemonGet(`/api/gate?repo=${encodeURIComponent(file)}`);
    if (!gate?.blocking?.length) return undefined;
    const res = await zenspec(["gate", "--repo", file], cwd);
    if (res.code !== 1) return undefined;
    const reason = `${res.stderr.trim().replace(/^zenspec: /, "") || "a review in this repo is not approved"}. ${BLOCK_ADVICE}`;
    return antigravity
      ? { decision: "deny", reason }
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
  }
  if (mode === "post" || mode === "antigravity-invocation") {
    const cwd = workingDir(input);
    const inbox = await daemonGet(`/api/inbox?repo=${encodeURIComponent(cwd)}`);
    if (!inbox) {
      if (hasLivingPlan(cwd)) startDaemon(cwd);
      return undefined;
    }
    const fresh = unseenReviews(inbox.items ?? []);
    if (!fresh.changed) return undefined;
    const res = await zenspec(["inbox", "--pending"], cwd);
    if (res.code !== 0) return undefined;
    fresh.save();
    const text = res.stdout.trim();
    if (!text) return undefined;
    const message = `${COMMENTS_HEADER}\n${text}`;
    return mode === "post"
      ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } }
      : { injectSteps: [{ ephemeralMessage: message }] };
  }
  return undefined;
}

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function workingDir(input) {
  const dir = input.cwd ?? input.workspacePaths?.[0];
  return typeof dir === "string" && dir ? dir : process.cwd();
}

/** The edit target in a tool's arguments; Antigravity's argument names are not documented. */
function pickPath(args, keys = ["TargetFile", "targetFile", "file_path", "filePath", "path"]) {
  if (!args || typeof args !== "object") return undefined;
  for (const key of keys) {
    if (typeof args[key] === "string" && args[key]) return args[key];
  }
  return undefined;
}

/**
 * Pending comments only appear with a new review of an approved plan, so the CLI (which marks
 * them delivered) runs only when an approved document's `lastReview` differs from the one seen
 * last time. The seen marks are a cache: losing them only costs one extra CLI call.
 */
function unseenReviews(items) {
  const file = path.join(process.env.CLAUDE_PLUGIN_DATA || os.tmpdir(), "zenspec-hook-seen.json");
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // First run.
  }
  const next = { ...seen };
  for (const item of items) {
    const phase = item?.doc?.phase;
    if (phase !== "approved" && phase !== "implementing") continue;
    next[path.join(item.doc.repoRoot, item.doc.relPath)] = item.lastReview;
  }
  return {
    changed: Object.keys(next).some((key) => next[key] !== seen[key]),
    save() {
      try {
        fs.writeFileSync(file, JSON.stringify(next));
      } catch {
        // Read-only temp dir: the CLI simply runs every time.
      }
    },
  };
}

function zenspecHome() {
  return process.env.ZENSPEC_HOME || path.join(os.homedir(), ".zenspec");
}

/**
 * Whether the repo containing `dir` has an approved or implementing plan, read straight from
 * `~/.zenspec` (the daemon's identity rules and a minimal phase replay, see core/reducer.ts).
 */
function hasLivingPlan(dir) {
  const root = gitRoot(dir);
  if (!root) return false;
  const slug = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const repoId = `${slug || "root"}-${createHash("sha256").update(root).digest("hex").slice(0, 6)}`;
  const docs = path.join(zenspecHome(), "repos", repoId, "docs");
  let ids = [];
  try {
    ids = fs.readdirSync(docs);
  } catch {
    return false;
  }
  return ids.some((id) => {
    try {
      return isLiving(fs.readFileSync(path.join(docs, id, "events.jsonl"), "utf8"));
    } catch {
      return false;
    }
  });
}

function gitRoot(dir) {
  let current;
  try {
    current = fs.realpathSync(dir);
  } catch {
    return undefined;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The reducer's phase rules, reduced to what decides approved or implementing. */
function isLiving(log) {
  let phase = "reviewing";
  for (const line of log.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "review_submitted" && event.verdict === "approved") {
      phase = phase === "implementing" || phase === "done" ? "done" : "approved";
    } else if (event.type === "step_checked" && event.checked && phase === "approved") {
      phase = "implementing";
    }
  }
  return phase === "approved" || phase === "implementing";
}

/** Starts `zenspec daemon run` detached; a daemon started meanwhile makes it exit. */
function startDaemon(cwd) {
  const [command, argv] = zenspecCommand(["daemon", "run"]);
  try {
    const child = spawn(command, argv, { cwd, detached: true, stdio: "ignore" });
    child.on("error", () => undefined); // Fail open.
    child.unref();
  } catch {
    // Fail open.
  }
}

/** GET a daemon route as JSON, or undefined when no daemon answers; never starts one. */
async function daemonGet(route) {
  let port;
  try {
    port = JSON.parse(fs.readFileSync(path.join(zenspecHome(), "daemon.json"), "utf8")).port;
  } catch {
    return undefined;
  }
  if (!Number.isInteger(port)) return undefined;
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: route, timeout: HTTP_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(body) : undefined);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
  });
}

function zenspecCommand(args) {
  const bin = process.env.ZENSPEC_BIN || "zenspec";
  return /\.[cm]?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

function zenspec(args, cwd) {
  const [command, argv] = zenspecCommand(args);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, argv, {
      cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLI_TIMEOUT_MS,
    });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", () => resolve({ code: -1, stdout: "", stderr: "" }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
