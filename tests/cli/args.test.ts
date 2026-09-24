import { describe, expect, it } from "vitest";
import { parseDuration, parseResponseFlag, parseResponsesYaml } from "../../src/cli/args.js";
import { EXIT } from "../../src/cli/errors.js";

describe("-r <id>:<action>[:<note>]", () => {
  it("splits only on the first two colons", () => {
    expect(parseResponseFlag("t8:answered:Use TTL: 5m, then refresh")).toEqual({
      thread: "t8",
      action: "answered",
      note: "Use TTL: 5m, then refresh",
    });
  });

  it("accepts a response without a note", () => {
    expect(parseResponseFlag("t2:edited")).toEqual({ thread: "t2", action: "edited" });
  });

  it.each(["t1", "t1:fixed", "t1:resolved:note", ":edited"])("rejects %s", (value) => {
    expect(() => parseResponseFlag(value)).toThrow(
      expect.objectContaining({ exitCode: EXIT.usage }),
    );
  });
});

describe("responses file", () => {
  it("reads a YAML list with multi-line notes", () => {
    const yaml =
      "- thread: t1\n  action: declined\n  note: |\n    Out of scope:\n    later.\n- {thread: t2, action: edited}\n";
    expect(parseResponsesYaml(yaml, "r.yaml")).toEqual([
      { thread: "t1", action: "declined", note: "Out of scope:\nlater.\n" },
      { thread: "t2", action: "edited" },
    ]);
  });

  it("treats an empty document as no responses", () => {
    expect(parseResponsesYaml("", "stdin")).toEqual([]);
  });

  it.each([
    ["not a list", "thread: t1"],
    ["a bad action", "- {thread: t1, action: done}"],
    ["invalid YAML", "- [unclosed"],
  ])("rejects %s", (_, yaml) => {
    expect(() => parseResponsesYaml(yaml, "stdin")).toThrow(
      expect.objectContaining({ exitCode: EXIT.usage }),
    );
  });
});

describe("--wait durations", () => {
  it.each([
    ["1500ms", 1500],
    ["30s", 30_000],
    ["10m", 600_000],
    ["1h", 3_600_000],
    ["45", 45_000],
  ])("parses %s", (value, ms) => {
    expect(parseDuration(value)).toBe(ms);
  });

  it("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow(expect.objectContaining({ exitCode: EXIT.usage }));
  });
});
