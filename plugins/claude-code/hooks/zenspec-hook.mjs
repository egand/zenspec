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
 * `ZENSPEC_BIN` overrides the `zenspec` executable (a `.js`/`.mjs` path runs under Node).
 */
import { spawn } from "node:child_process";
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
    const fresh = unseenReviews(inbox?.items ?? []);
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

/** GET a daemon route as JSON, or undefined when no daemon answers; never starts one. */
async function daemonGet(route) {
  const home = process.env.ZENSPEC_HOME || path.join(os.homedir(), ".zenspec");
  let port;
  try {
    port = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8")).port;
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

function zenspec(args, cwd) {
  const bin = process.env.ZENSPEC_BIN || "zenspec";
  const [command, argv] = /\.[cm]?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
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
