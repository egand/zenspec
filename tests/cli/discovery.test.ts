import { describe, expect, it } from "vitest";
import { run, startStub, tempDirs, writeDaemonJson } from "./harness.js";

/** `daemon status` goes through discovery without side effects, so it shows which port is used. */
describe("daemon discovery", () => {
  it("uses the port recorded in daemon.json", async () => {
    const { home, repo } = tempDirs();
    const stub = await startStub();
    writeDaemonJson(home, stub.port);
    const result = await run(["daemon", "status"], { home, cwd: repo });
    expect(result.stdout).toBe(
      `running pid ${process.pid} port ${stub.port} version ${__ZENSPEC_VERSION__}\n`,
    );
  });

  it("starts a daemon when daemon.json is missing and picks up its port", async () => {
    const { home, repo } = tempDirs();
    const fresh = await startStub({ "POST /api/inbox/pending": () => ({ body: { items: [] } }) });
    const result = await run(["inbox", "--pending"], {
      home,
      cwd: repo,
      spawnDaemon: () => writeDaemonJson(home, fresh.port),
    });
    expect(result).toMatchObject({ code: 0, spawned: 1 });
    expect(fresh.callsTo("POST /api/inbox/pending")).toHaveLength(1);
  });

  it("stops a daemon of another version and restarts it", async () => {
    const { home, repo } = tempDirs();
    const fresh = await startStub({ "POST /api/inbox/pending": () => ({ body: { items: [] } }) });
    const stale = await startStub(
      {
        "POST /api/daemon/stop": () => {
          setImmediate(() => void stale.close());
          return { body: {} };
        },
      },
      "0.0.1-stale",
    );
    writeDaemonJson(home, stale.port, "0.0.1-stale");

    const result = await run(["inbox", "--pending"], {
      home,
      cwd: repo,
      spawnDaemon: () => writeDaemonJson(home, fresh.port),
    });
    expect(result).toMatchObject({ code: 0, spawned: 1, stderr: "" });
    expect(stale.callsTo("POST /api/daemon/stop")).toHaveLength(1);
    expect(fresh.callsTo("POST /api/inbox/pending")).toHaveLength(1);
  });
});
