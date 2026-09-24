/**
 * End-to-end protocol (plan §8, §10, §13, §14): the built `dist/cli.mjs` as the agent, the
 * daemon it auto-spawns, and direct HTTP calls to the daemon routes as the reviewer.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { ROUTES, type DaemonInfo, type OpenDocResponse } from "../../src/core/api.js";
import type { ReviewPayload } from "../../src/core/payload.js";
import { latestRevision, replay } from "../../src/core/reducer.js";
import { Api, Doc, tempDir, tempRepo } from "../daemon/helpers.js";

const CLI = fileURLToPath(new URL("../../dist/cli.mjs", import.meta.url));
const STALE_DAEMON = fileURLToPath(new URL("../daemon/fixtures/run-daemon.ts", import.meta.url));
const WAIT = { timeout: 10_000, interval: 20 };
const PLAN_PATH = "docs/plans/plan.md";
const PLAN = [
  "# Plan",
  "",
  "## Storage",
  "",
  "Use Redis for the session table.",
  "",
  "> [!QUESTION] Which database engine? {#db-engine}",
  "> - PostgreSQL",
  "> - SQLite",
  "",
  "## Steps",
  "",
  "- [ ] Build event log",
  "- [ ] Write daemon",
  "",
].join("\n");

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

const children = new Set<ChildProcess>();
const homes: string[] = [];
let daemonsBefore: string[] = [];

/** Daemons of this build running on the machine, as `ps` lines. */
function runningDaemons(): string[] {
  const ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return ps.split("\n").filter((line) => line.includes(`${CLI} daemon run`));
}

beforeAll(() => {
  daemonsBefore = runningDaemons();
});

// Stops every daemon a test started, then checks that none was orphaned.
afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const home of homes.splice(0)) {
    const pid = daemonInfo(home)?.pid;
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGTERM");
  }
  await vi.waitFor(() => expect(runningDaemons()).toEqual(daemonsBefore), WAIT);
});

function daemonInfo(home: string): DaemonInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8")) as DaemonInfo;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function track(child: ChildProcess): ChildProcess {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

/** A temp git repo holding the plan, and a temp `ZENSPEC_HOME` with no daemon running yet. */
function workspace() {
  const repo = tempRepo({ [PLAN_PATH]: PLAN });
  const home = tempDir("home");
  // Backstop: a daemon the cleanup misses exits on its own.
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    "openBrowser: false\ndaemon:\n  idleMinutes: 1\n",
  );
  homes.push(home);
  const env = { ...process.env, ZENSPEC_HOME: home };
  const file = path.join(repo, PLAN_PATH);

  /** One invocation of the built CLI, as the agent runs it. */
  function zenspec(...args: string[]): Promise<Result> {
    const child = track(spawn(process.execPath, [CLI, ...args], { cwd: repo, env }));
    const result: Result = { code: null, stdout: "", stderr: "" };
    child.stdout!.setEncoding("utf8").on("data", (s: string) => (result.stdout += s));
    child.stderr!.setEncoding("utf8").on("data", (s: string) => (result.stderr += s));
    return once(child, "close").then(([code]) => ({ ...result, code: code as number | null }));
  }

  /** The reviewer's handle on the plan, once the agent has published `revision`. */
  function reviewer(revision: number): Promise<Doc> {
    return vi.waitFor(async () => {
      const info = daemonInfo(home);
      expect(info).toBeDefined();
      const api = new Api(`http://127.0.0.1:${info!.port}`);
      const { doc } = await api.ok<OpenDocResponse>("POST", ROUTES.docs, { path: file });
      const handle = new Doc(api, file, doc.repoId, doc.docId);
      expect(latestRevision(replay((await handle.state()).events))?.n).toBe(revision);
      return handle;
    }, WAIT);
  }

  return { repo, home, env, file, zenspec, reviewer };
}

type Workspace = ReturnType<typeof workspace>;

function payloadOf(result: Result): ReviewPayload {
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return parse(result.stdout) as ReviewPayload;
}

/** Publish the plan and have the reviewer approve it straight away. */
async function approve(w: Workspace): Promise<Doc> {
  const waiting = w.zenspec("review", PLAN_PATH, "--no-open");
  const doc = await w.reviewer(1);
  await doc.submit({ revision: 1, verdict: "approved" });
  expect(payloadOf(await waiting).verdict).toBe("approved");
  return doc;
}

describe("zenspec CLI against the real daemon", { timeout: 30_000 }, () => {
  it("runs full review rounds with exactly one CLI call per round", async () => {
    const w = workspace();

    // Scripted agent: each round is a single `review` call that publishes, responds, and
    // waits; it edits the plan between rounds and answers every thread it received.
    const invocations: string[][] = [];
    const agent = (async () => {
      const payloads: ReviewPayload[] = [];
      let responses: string[] = [];
      for (;;) {
        const args = ["review", PLAN_PATH, "--no-open", ...responses];
        invocations.push(args);
        const payload = payloadOf(await w.zenspec(...args));
        payloads.push(payload);
        if (payload.verdict === "approved") return payloads;
        fs.writeFileSync(
          w.file,
          PLAN.replace("Use Redis", "Use managed Redis") + "\n## Rollback\n\nRevert.\n",
        );
        responses = (payload.threads ?? []).flatMap((t) => ["-r", `${t.id}:edited:done`]);
        responses.push("-m", "addressed review");
      }
    })();

    const doc = await w.reviewer(1);
    await doc.submit({
      revision: 1,
      verdict: "changes_requested",
      summary: "Needs work",
      opened: [
        {
          kind: "comment",
          anchor: doc.anchor(PLAN, "session table", 1),
          body: "Why Redis?",
          attachments: [],
        },
        {
          kind: "suggestion",
          anchor: doc.anchor(PLAN, "Use Redis", 1),
          old: "Use Redis",
          new: "Use managed Redis",
          body: "",
          attachments: [],
        },
        {
          kind: "decision",
          anchor: doc.anchor(PLAN, "Which database engine?", 1),
          question: "db-engine",
          choice: { mode: "single", option: "PostgreSQL" },
          body: "keep SQLite for tests",
          attachments: [],
        },
        { kind: "general", body: "Add a rollback section", attachments: [] },
      ],
    });
    const revised = await w.reviewer(2);
    const state = replay((await revised.state()).events);
    expect(state.revisions.at(-1)?.summary).toBe("addressed review");
    expect(state.threadOrder.map((id) => state.threads[id]!.status)).toEqual([
      "addressed",
      "addressed",
      "addressed",
      "addressed",
    ]);
    await revised.submit({ revision: 2, verdict: "approved", resolved: state.threadOrder });

    const payloads = await agent;
    expect(invocations).toHaveLength(2); // two review rounds, one call each
    expect(payloads[0]).toEqual({
      verdict: "changes_requested",
      review: 1,
      revision: 1,
      summary: "Needs work",
      threads: [
        { id: "t1", kind: "comment", at: "L5", quote: "session table", body: "Why Redis?" },
        { id: "t2", kind: "suggestion", at: "L5", old: "Use Redis", new: "Use managed Redis" },
        {
          id: "t3",
          kind: "decision",
          question: "db-engine",
          at: "L7",
          choice: "PostgreSQL",
          body: "keep SQLite for tests",
        },
        { id: "t4", kind: "general", body: "Add a rollback section" },
      ],
      next: `zenspec review ${PLAN_PATH} -r <id>:<edited|answered|declined>[:note]`,
    });
    expect(payloads[1]).toEqual({
      verdict: "approved",
      review: 2,
      revision: 2,
      next: `implement, ticking each step's checkbox; then zenspec review ${PLAN_PATH} -m implemented`,
    });
  });

  it("delivers the same payload to concurrent waiters on one document", async () => {
    const w = workspace();
    const waiters = [
      w.zenspec("review", PLAN_PATH, "--no-open"),
      w.zenspec("review", PLAN_PATH, "--no-open"),
    ];
    const doc = await w.reviewer(1);
    await doc.submit({
      revision: 1,
      verdict: "comment",
      opened: [{ kind: "general", body: "Looks fine", attachments: [] }],
    });
    const [a, b] = await Promise.all(waiters);
    expect(payloadOf(a!)).toMatchObject({ verdict: "comment", threads: [{ id: "t1" }] });
    expect(b!.stdout).toBe(a!.stdout);
  });

  it("returns `verdict: pending` when --wait expires", async () => {
    const w = workspace();
    expect(await w.zenspec("review", PLAN_PATH, "--no-open", "--wait", "1s")).toEqual({
      code: 0,
      stdout: `verdict: pending\nnext: zenspec review ${PLAN_PATH} --wait 1s\n`,
      stderr: "",
    });
  });

  it("gates the repo while the plan is in review and allows edits after approval", async () => {
    const w = workspace();
    const waiting = w.zenspec("review", PLAN_PATH, "--no-open");
    const doc = await w.reviewer(1);

    const blocked = await w.zenspec("gate", "--repo");
    expect(blocked).toMatchObject({ code: 1, stdout: "" });
    expect(blocked.stderr).toMatch(/^zenspec: blocked until approved: docs\/plans\/plan\.md/);
    // The plan itself stays editable.
    expect((await w.zenspec("gate", "--repo", PLAN_PATH)).code).toBe(0);

    await doc.submit({ revision: 1, verdict: "approved" });
    await waiting;
    expect(await w.zenspec("gate", "--repo")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((await w.zenspec("gate", PLAN_PATH)).code).toBe(0);
  });

  it("closes the session and wakes the waiting review with `verdict: closed`", async () => {
    const w = workspace();
    const waiting = w.zenspec("review", PLAN_PATH, "--no-open");
    await w.reviewer(1);
    expect(await w.zenspec("close", PLAN_PATH)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await waiting).toEqual({
      code: 0,
      stdout: "verdict: closed\nby: agent\nnext: none\n",
      stderr: "",
    });
  });

  it("tracks checked steps and drift on the approved plan", async () => {
    const w = workspace();
    const doc = await approve(w);
    const state = async () => replay((await doc.state()).events);

    const ticked = PLAN.replace("- [ ] Build", "- [x] Build");
    fs.writeFileSync(w.file, ticked);
    await vi.waitFor(async () => {
      expect((await state()).steps["steps/build-event-log"]?.checked).toBe(true);
    }, WAIT);
    expect((await state()).drift).toEqual([]);

    fs.writeFileSync(w.file, ticked + "- [ ] Ship it\n");
    await vi.waitFor(async () => {
      expect((await state()).drift).toMatchObject([
        { revision: 1, diffSummary: "+1 -0 lines at L15" },
      ]);
    }, WAIT);
    expect((await w.zenspec("status")).stdout).toMatch(
      /^docs\/plans\/plan\.md implementing rev 1 approved /,
    );
  });

  it("fails with a message on stderr and nothing on stdout for unknown files", async () => {
    const w = workspace();
    expect(await w.zenspec("review", "missing.md", "--no-open")).toEqual({
      code: 3,
      stdout: "",
      stderr: "zenspec: no such file: missing.md\n",
    });
    const unreviewed = await w.zenspec("gate", PLAN_PATH);
    expect(unreviewed).toMatchObject({ code: 3, stdout: "" });
    expect(unreviewed.stderr).toMatch(/^zenspec: Not under review: .*plan\.md\n$/);
  });

  it("auto-spawns the daemon, and `daemon stop` leaves no process behind", async () => {
    const w = workspace();
    expect(daemonInfo(w.home)).toBeUndefined();
    expect(await w.zenspec("status")).toMatchObject({ code: 0, stdout: "no open reviews\n" });
    const info = daemonInfo(w.home)!;
    expect(info.version).toBe(__ZENSPEC_VERSION__);
    expect(alive(info.pid)).toBe(true);

    expect(await w.zenspec("daemon", "stop")).toEqual({ code: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(alive(info.pid)).toBe(false), WAIT);
    expect(daemonInfo(w.home)).toBeUndefined();
    expect(await w.zenspec("daemon", "status")).toMatchObject({ code: 4, stdout: "not running\n" });
  });

  it("restarts a daemon of another version", async () => {
    const w = workspace();
    const stale = track(
      spawn(process.execPath, ["--import", "tsx", STALE_DAEMON], {
        env: { ...w.env, ZENSPEC_DAEMON_VERSION: "0.0.0-stale" },
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
    const exited = once(stale, "exit");
    await once(createInterface({ input: stale.stdout! }), "line");
    expect(daemonInfo(w.home)).toMatchObject({ pid: stale.pid, version: "0.0.0-stale" });

    expect(await w.zenspec("status")).toMatchObject({ code: 0, stdout: "no open reviews\n" });
    expect(await exited).toEqual([0, null]);
    const info = daemonInfo(w.home)!;
    expect(info).toMatchObject({ version: __ZENSPEC_VERSION__ });
    expect(info.pid).not.toBe(stale.pid);
    expect(alive(info.pid)).toBe(true);
  });
});
