/**
 * The Claude Code / Antigravity hook script (plan §10, §14), run as a child process with
 * sample hook JSON on stdin against a real in-process daemon and the built CLI.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { startTestDaemon, tempDir, tempRepo } from "../daemon/helpers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN = path.join(ROOT, "plugins/claude-code");
const HOOK = path.join(PLUGIN, "hooks/zenspec-hook.mjs");
const CLI = path.join(ROOT, "dist/cli.mjs");
const PLAN = "# Plan\n\n## Steps\n\n- [ ] Build event log\n";

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(mode: string, input: unknown, env: Record<string, string>): Promise<HookRun> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, mode], {
      env: { ...process.env, ZENSPEC_BIN: CLI, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started) }),
    );
    child.stdin.end(JSON.stringify(input));
  });
}

const edit = (cwd: string, file: string) => ({
  session_id: "s1",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path: file, old_string: "a", new_string: "b" },
});
const posted = (cwd: string) => ({
  session_id: "s1",
  cwd,
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: path.join(cwd, "src/app.ts") },
  tool_response: { success: true },
});

/** A repo whose plan is published and reviewed with `verdict`. */
async function reviewedRepo(verdict: "approved" | "changes_requested") {
  const root = tempRepo({ "docs/plans/plan.md": PLAN, "src/app.ts": "" });
  const t = await startTestDaemon();
  const doc = await t.open(`${root}/docs/plans/plan.md`);
  await doc.publish();
  await doc.submit({ revision: 1, verdict });
  return { ...t, root, doc, env: { ZENSPEC_HOME: t.home, CLAUDE_PLUGIN_DATA: tempDir("data") } };
}

const silent = { code: 0, stdout: "", stderr: "" };

describe("PreToolUse gate hook", () => {
  it("denies code edits while the plan is unapproved, with a one-line reason", async () => {
    const { root, env } = await reviewedRepo("changes_requested");
    const run = await runHook("pre", edit(root, path.join(root, "src/app.ts")), env);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("docs/plans/plan.md"),
      },
    });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("verdict: approved");
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain("\n");
  });

  it("resolves relative paths and NotebookEdit's notebook_path", async () => {
    const { root, env } = await reviewedRepo("changes_requested");
    const input = {
      cwd: root,
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "a.ipynb" },
    };
    expect(JSON.parse((await runHook("pre", input, env)).stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("stays silent for the plan itself and after approval", async () => {
    const blocked = await reviewedRepo("changes_requested");
    const planEdit = edit(blocked.root, path.join(blocked.root, "docs/plans/plan.md"));
    expect(await runHook("pre", planEdit, blocked.env)).toMatchObject(silent);

    const approved = await reviewedRepo("approved");
    const codeEdit = edit(approved.root, path.join(approved.root, "src/app.ts"));
    expect(await runHook("pre", codeEdit, approved.env)).toMatchObject(silent);
  });

  it("fails open when the daemon is down, zenspec is missing, or the input is garbage", async () => {
    const { root, env, daemon } = await reviewedRepo("changes_requested");
    const input = edit(root, path.join(root, "src/app.ts"));
    const missingBin = { ...env, ZENSPEC_BIN: path.join(root, "no-such-zenspec") };
    expect(await runHook("pre", input, missingBin)).toMatchObject(silent);
    expect(await runHook("pre", "not json", env)).toMatchObject(silent);

    // A stale daemon.json (pointing at a dead port) and no daemon.json at all.
    const info = fs.readFileSync(path.join(env.ZENSPEC_HOME, "daemon.json"), "utf8");
    await daemon.stop();
    fs.writeFileSync(path.join(env.ZENSPEC_HOME, "daemon.json"), info);
    expect(await runHook("pre", input, env)).toMatchObject(silent);
    expect(await runHook("pre", input, { ZENSPEC_HOME: tempDir("home") })).toMatchObject(silent);
    // The hook never starts a daemon.
    expect(
      (await fetch(`http://127.0.0.1:${JSON.parse(info).port}/api/health`).catch(() => null))?.ok ??
        false,
    ).toBe(false);
  });
});

describe("PostToolUse inbox hook", () => {
  it("prints nothing when nothing is pending or no daemon runs", async () => {
    const { root, env } = await reviewedRepo("approved");
    expect(await runHook("post", posted(root), env)).toMatchObject(silent);
    expect(await runHook("post", posted(root), { ZENSPEC_HOME: tempDir("home") })).toMatchObject(
      silent,
    );
  });

  it("injects implementation-time comments once as additionalContext", async () => {
    const { root, env, doc } = await reviewedRepo("approved");
    await doc.submit({
      revision: 1,
      verdict: "comment",
      opened: [{ kind: "general", body: "Careful with step 2", attachments: [] }],
    });
    const run = await runHook("post", posted(root), env);
    expect(run.code).toBe(0);
    const context: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(JSON.parse(run.stdout).hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(context.split("\n")[0]).toMatch(/^Reviewer comments on the approved plan/);
    expect(context).toContain("# docs/plans/plan.md");
    expect(context).toContain("Careful with step 2");
    expect(await runHook("post", posted(root), env)).toMatchObject(silent);
  });
});

describe("PostToolUse daemon start", () => {
  const daemonPid = (home: string): number | undefined => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8")).pid;
    } catch {
      return undefined;
    }
  };

  it("starts the daemon when the repo has an approved plan and none is running", async () => {
    const { root, env, daemon } = await reviewedRepo("approved");
    await daemon.stop();
    const run = await runHook("post", posted(root), env);
    expect(run).toMatchObject(silent);
    expect(run.ms).toBeLessThan(2000);
    const pid = await vi.waitFor(
      () => {
        const found = daemonPid(env.ZENSPEC_HOME);
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: 10_000, interval: 50 },
    );
    process.kill(pid, "SIGTERM");
    await vi.waitFor(() => expect(daemonPid(env.ZENSPEC_HOME)).toBeUndefined(), {
      timeout: 10_000,
      interval: 50,
    });
  });

  it("does not start one for a plan that is not approved", async () => {
    const { root, env, daemon } = await reviewedRepo("changes_requested");
    await daemon.stop();
    expect(await runHook("post", posted(root), env)).toMatchObject(silent);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(daemonPid(env.ZENSPEC_HOME)).toBeUndefined();
  });
});

describe("Antigravity modes (experimental)", () => {
  it("denies with {decision, reason} and injects comments as an ephemeral message", async () => {
    const { root, env, doc } = await reviewedRepo("changes_requested");
    const call = {
      workspacePaths: [root],
      toolCall: { name: "replace_file_content", args: { TargetFile: `${root}/src/app.ts` } },
      stepIdx: 3,
    };
    expect(JSON.parse((await runHook("antigravity-pre", call, env)).stdout)).toEqual({
      decision: "deny",
      reason: expect.stringContaining("docs/plans/plan.md"),
    });

    await doc.submit({ revision: 1, verdict: "approved" });
    expect(await runHook("antigravity-pre", call, env)).toMatchObject(silent);
    await doc.submit({
      revision: 1,
      verdict: "comment",
      opened: [{ kind: "general", body: "Mind the cache", attachments: [] }],
    });
    const out = JSON.parse((await runHook("antigravity-invocation", call, env)).stdout);
    expect(out.injectSteps[0].ephemeralMessage).toContain("Mind the cache");
  });
});

describe("plugin layout", () => {
  it("wires both hooks to the bundled script and bundles the current skill", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("zenspec");
    const { hooks } = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks/hooks.json"), "utf8"));
    expect(hooks.PreToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(hooks.PreToolUse[0].hooks[0].command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/zenspec-hook.mjs" pre',
    );
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/zenspec-hook.mjs" post',
    );
    const skill = fs.readFileSync(path.join(ROOT, "skills/zenspec/SKILL.md"), "utf8");
    for (const copy of ["claude-code", "antigravity"]) {
      const file = path.join(ROOT, "plugins", copy, "skills/zenspec/SKILL.md");
      expect(fs.readFileSync(file, "utf8"), copy).toBe(skill);
    }
    const agHooks = fs.readFileSync(
      path.join(ROOT, "plugins/antigravity/hooks.example.json"),
      "utf8",
    );
    expect(agHooks).toContain("zenspec-hook.mjs antigravity-pre");
  });
});
