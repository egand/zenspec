import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GateResponse, InboxItem } from "../../src/core/api.js";
import { formatPayloadYaml } from "../../src/core/format-payload.js";
import { EXIT } from "../../src/cli/errors.js";
import {
  DOC,
  PAYLOAD,
  openDocReply,
  run,
  startStub,
  tempDirs,
  writeDaemonJson,
  writePlan,
  type StubHandler,
} from "./harness.js";

async function setup(routes: Record<string, StubHandler>) {
  const { home, repo } = tempDirs();
  const stub = await startStub(routes);
  writeDaemonJson(home, stub.port);
  return { stub, repo, opts: { home, cwd: repo } };
}

describe("zenspec gate", () => {
  const blockedBy = (repo: string): GateResponse => ({
    approved: false,
    blocking: [{ doc: openDocReply(repo).doc, phase: "in_review" }],
  });

  it("exits 0 for an approved document and 1 with a reason otherwise", async () => {
    let approved = true;
    const { stub, repo, opts } = await setup({
      "GET /api/gate": () => ({ body: approved ? { approved, blocking: [] } : blockedBy(repo) }),
    });
    const file = writePlan(repo);

    expect(await run(["gate", file], opts)).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(stub.callsTo("GET /api/gate")[0].query.get("path")).toBe(file);

    approved = false;
    const blocked = await run(["gate", file], opts);
    expect(blocked).toMatchObject({ code: EXIT.blocked, stdout: "" });
    expect(blocked.stderr).toBe(
      "zenspec: blocked until approved: docs/plans/plan.md (in review); wait for the review\n",
    );
  });

  it("in repo mode, blocks other edits but allows plan files", async () => {
    const { stub, repo, opts } = await setup({
      "GET /api/gate": () => ({ body: blockedBy(repo) }),
    });

    expect((await run(["gate", "--repo"], opts)).code).toBe(EXIT.blocked);
    expect(stub.callsTo("GET /api/gate")[0].query.get("repo")).toBe(repo);
    expect((await run(["gate", "--repo", "src/app.ts"], opts)).code).toBe(EXIT.blocked);
    expect((await run(["gate", "--repo", "docs/plans/other.md"], opts)).code).toBe(EXIT.ok);
    expect(stub.callsTo("GET /api/gate")[1].query.get("repo")).toBe(path.join(repo, "src/app.ts"));
  });
});

describe("zenspec inbox --pending", () => {
  it("prints nothing when there is nothing new", async () => {
    const { stub, repo, opts } = await setup({
      "POST /api/inbox/pending": () => ({ body: { items: [] } }),
    });
    expect(await run(["inbox", "--pending"], opts)).toEqual(
      expect.objectContaining({ code: 0, stdout: "", stderr: "" }),
    );
    expect(stub.callsTo("POST /api/inbox/pending")[0].body).toEqual({ repo });
  });

  it("prints each document's payload under its path", async () => {
    const { repo, opts } = await setup({
      "POST /api/inbox/pending": () => ({
        body: { items: [{ doc: openDocReply(repo).doc, payload: PAYLOAD }] },
      }),
    });
    expect((await run(["inbox", "--pending"], opts)).stdout).toBe(
      `# docs/plans/plan.md\n${formatPayloadYaml(PAYLOAD)}`,
    );
  });
});

describe("zenspec status and close", () => {
  it("lists only open reviews in the current repo", async () => {
    const item = (relPath: string, phase: "in_review" | "done"): InboxItem => ({
      doc: { ...openDocReply("/r").doc, relPath, phase },
      url: `http://127.0.0.1/d/${relPath}`,
      lastRevision: 2,
      lastReview: 1,
      lastVerdict: "comment",
      openThreads: 3,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const { stub, repo, opts } = await setup({
      "GET /api/inbox": () => ({
        body: { items: [item("a.md", "in_review"), item("b.md", "done")] },
      }),
    });
    expect((await run(["status"], opts)).stdout).toBe(
      "a.md in_review rev 2 comment 3 open http://127.0.0.1/d/a.md\n",
    );
    expect(stub.callsTo("GET /api/inbox")[0].query.get("repo")).toBe(repo);
  });

  it("closes the document's session as the agent", async () => {
    const { stub, repo, opts } = await setup({
      "POST /api/docs": () => ({ body: openDocReply(repo, true) }),
      [`POST ${DOC}/close`]: () => ({ body: {} }),
    });
    writePlan(repo);
    expect(await run(["close", "docs/plans/plan.md"], opts)).toMatchObject({ code: 0, stdout: "" });
    expect(stub.callsTo(`POST ${DOC}/close`)[0].body).toEqual({ by: "agent" });
  });
});

describe("dispatch and help", () => {
  const opts = () => ({ ...tempDirs(), cwd: "/" });

  it("rejects unknown commands with usage on stderr", async () => {
    const result = await run(["frobnicate"], opts());
    expect(result).toMatchObject({ code: EXIT.usage, stdout: "" });
    expect(result.stderr).toMatch(/^zenspec: unknown command: frobnicate\nusage: zenspec/);
  });

  it.each(["adr", "export"])(
    "%s reports a missing file before contacting the daemon",
    async (name) => {
      expect(await run([name, "missing.md"], opts())).toMatchObject({
        code: EXIT.notFound,
        stdout: "",
        stderr: "zenspec: no such file: missing.md\n",
      });
      expect((await run([name], opts())).code).toBe(EXIT.usage);
    },
  );

  it("prints help for one command and for all", async () => {
    const one = await run(["review", "--help"], opts());
    expect(one.code).toBe(0);
    expect(one.stdout).toMatch(/^zenspec review <file>/);
    expect(one.stdout).not.toContain("zenspec gate");
    const all = await run(["help"], opts());
    for (const name of ["review", "gate", "close", "status", "inbox", "daemon", "adr", "export"]) {
      expect(all.stdout).toContain(`zenspec ${name}`);
    }
  });
});
