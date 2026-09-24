import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingPayload, formatPayloadYaml } from "../../src/core/format-payload.js";
import { EXIT } from "../../src/cli/errors.js";
import {
  DOC,
  PAYLOAD,
  PUBLISHED,
  openDocReply,
  run,
  startStub,
  tempDirs,
  writeDaemonJson,
  writePlan,
  type StubHandler,
} from "./harness.js";

const FILE = "docs/plans/plan.md";

async function setup(next: StubHandler, viewed = false) {
  const { home, repo } = tempDirs();
  writePlan(repo);
  const stub = await startStub({
    "POST /api/docs": () => ({ body: openDocReply(repo, viewed) }),
    [`POST ${DOC}/revisions`]: () => ({ body: PUBLISHED }),
    [`GET ${DOC}/reviews/next`]: next,
  });
  writeDaemonJson(home, stub.port);
  return { stub, home, repo, opts: { home, cwd: repo } };
}

const delivered: StubHandler = () => ({ body: { status: "delivered", payload: PAYLOAD } });

describe("zenspec review", () => {
  it("publishes, responds, opens the browser, and prints exactly the payload", async () => {
    const { stub, repo, opts } = await setup(delivered);
    const stdin = "- thread: t3\n  action: declined\n  note: not now\n";
    const result = await run(
      [
        "review",
        FILE,
        "-m",
        "tweak",
        "-r",
        "t1:answered:a: b",
        "-r",
        "t2:edited",
        "--responses-file",
        "-",
      ],
      { ...opts, stdin },
    );

    expect(result).toMatchObject({ code: 0, stderr: "", stdout: formatPayloadYaml(PAYLOAD) });
    expect(result.opened).toEqual(["http://127.0.0.1/d/r1/d1"]);
    expect(stub.callsTo("POST /api/docs")[0].body).toEqual({ path: path.join(repo, FILE) });
    expect(stub.callsTo(`POST ${DOC}/revisions`)[0].body).toEqual({
      author: "agent",
      summary: "tweak",
      responses: [
        { thread: "t1", action: "answered", note: "a: b" },
        { thread: "t2", action: "edited" },
        { thread: "t3", action: "declined", note: "not now" },
      ],
    });
    const [wait] = stub.callsTo(`GET ${DOC}/reviews/next`);
    expect(Object.fromEntries(wait.query)).toEqual({ after: "4" });
  });

  it("does not open the browser when a tab is connected or with --no-open", async () => {
    const viewed = await setup(delivered, true);
    expect((await run(["review", FILE], viewed.opts)).opened).toEqual([]);
    const noOpen = await setup(delivered);
    expect((await run(["review", FILE, "--no-open"], noOpen.opts)).opened).toEqual([]);
  });

  it("prints a pending payload with the same command when --wait expires", async () => {
    const { stub, opts } = await setup(() => ({
      body: { status: "pending", payload: { verdict: "pending", next: "ignored" } },
    }));
    const result = await run(["review", FILE, "--wait", "5s"], opts);

    expect(result).toMatchObject({
      code: 0,
      stdout: formatPayloadYaml(buildPendingPayload(FILE, "5s")),
    });
    const timeoutMs = Number(stub.callsTo(`GET ${DOC}/reviews/next`)[0].query.get("timeoutMs"));
    expect(timeoutMs).toBeGreaterThan(4000);
    expect(timeoutMs).toBeLessThanOrEqual(5000);
  });

  it("retries transparently when the connection drops mid-wait", async () => {
    let attempts = 0;
    const { stub, opts } = await setup((req) => (++attempts === 1 ? "drop" : delivered(req)));
    const result = await run(["review", FILE], opts);

    expect(result).toMatchObject({ code: 0, stderr: "", stdout: formatPayloadYaml(PAYLOAD) });
    expect(stub.callsTo(`GET ${DOC}/reviews/next`)).toHaveLength(2);
    expect(stub.callsTo(`POST ${DOC}/revisions`)).toHaveLength(1);
  });

  it("prints nothing on stdout and exits with a distinct code per error", async () => {
    const { stub, opts } = await setup(() => ({
      status: 409,
      body: { error: { code: "conflict", message: "session closed" } },
    }));
    const cases: [string[], number][] = [
      [["review"], EXIT.usage],
      [["review", FILE, "-r", "t1:fixed"], EXIT.usage],
      [["review", FILE, "--bogus"], EXIT.usage],
      [["review", "docs/plans/missing.md"], EXIT.notFound],
      [["review", FILE], EXIT.failure],
    ];
    for (const [argv, code] of cases) {
      const result = await run(argv, opts);
      expect({ argv, code: result.code, stdout: result.stdout }).toEqual({
        argv,
        code,
        stdout: "",
      });
      expect(result.stderr).toMatch(/^zenspec: .+\n/);
    }

    await stub.close();
    const down = await run(["review", FILE], opts);
    expect(down).toMatchObject({ code: EXIT.unreachable, stdout: "", spawned: 1 });
    expect(down.stderr).toBe("zenspec: daemon did not start\n");
  });
});
