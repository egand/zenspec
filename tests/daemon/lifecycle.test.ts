import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ROUTES } from "../../src/core/api.js";
import { DaemonAlreadyRunningError, startDaemon } from "../../src/daemon/index.js";
import { readDaemonInfo } from "../../src/daemon/home.js";
import { startTestDaemon, tempDir } from "./helpers.js";

it("removes legacy v1 state and records daemon.json", async () => {
  const home = tempDir("home");
  fs.mkdirSync(path.join(home, "sessions", "abc"), { recursive: true });
  fs.writeFileSync(path.join(home, "state.json"), "{}");

  const { daemon } = await startTestDaemon({ home, version: "9.9.9" });
  expect(fs.existsSync(path.join(home, "sessions"))).toBe(false);
  expect(fs.existsSync(path.join(home, "state.json"))).toBe(false);
  expect(readDaemonInfo(home)).toEqual({ pid: process.pid, port: daemon.port, version: "9.9.9" });

  await daemon.stop();
  expect(readDaemonInfo(home)).toBeNull();
});

it("refuses to start next to a live daemon of the same version", async () => {
  const { home } = await startTestDaemon({ version: "1.0.0" });
  await expect(startDaemon({ home, port: 0, version: "1.0.0" })).rejects.toBeInstanceOf(
    DaemonAlreadyRunningError,
  );
});

it("takes over the lock of a daemon that died without releasing it", async () => {
  const home = tempDir("home");
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(path.join(home, "daemon.lock"), String(deadPid));
  const { daemon } = await startTestDaemon({ home });
  expect(fs.readFileSync(path.join(home, "daemon.lock"), "utf8")).toBe(String(process.pid));
  await daemon.stop();
  expect(fs.existsSync(path.join(home, "daemon.lock"))).toBe(false);
});

it("rejects cross-origin requests", async () => {
  const { api } = await startTestDaemon();
  const res = await fetch(api.base + ROUTES.health, { headers: { Origin: "https://evil.test" } });
  expect(res.status).toBe(403);
});

it("shuts down when idle", async () => {
  const { daemon } = await startTestDaemon({ idleMs: 10 });
  await daemon.stopped;
  await expect(fetch(daemon.url + ROUTES.health)).rejects.toThrow();
});

it("exits the process when asked to stop", async () => {
  const home = tempDir("home");
  const script = fileURLToPath(new URL("./fixtures/run-daemon.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, ZENSPEC_HOME: home },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  const [line] = (await once(createInterface({ input: child.stdout! }), "line")) as [string];
  const { port } = JSON.parse(line) as { port: number };
  expect(readDaemonInfo(home)).toMatchObject({ pid: child.pid, port });

  const res = await fetch(`http://127.0.0.1:${port}${ROUTES.stop}`, { method: "POST" });
  expect(res.status).toBe(200);
  const [code] = await exited;
  expect(code).toBe(0);
  expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  expect(readDaemonInfo(home)).toBeNull();
});
