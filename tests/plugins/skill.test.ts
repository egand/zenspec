/** The skill is standing context (plan §3, §14): keep it small and in sync with the CLI. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { expect, it } from "vitest";
import { estimateTokens } from "../../src/core/tokens.js";

const skill = fs.readFileSync(new URL("../../skills/zenspec/SKILL.md", import.meta.url), "utf8");
const cli = fileURLToPath(new URL("../../dist/cli.mjs", import.meta.url));
const help = (...args: string[]) =>
  execFileSync(process.execPath, [cli, "help", ...args], { encoding: "utf8" });

it("stays within its token and line budget", () => {
  expect(estimateTokens(skill)).toBeLessThanOrEqual(700);
  expect(skill.split("\n").length).toBeLessThanOrEqual(50);
});

it("has a short frontmatter with a name and description", () => {
  const front = parseYaml(skill.split("---\n")[1]!) as Record<string, string>;
  expect(Object.keys(front)).toEqual(["name", "description"]);
  expect(front.name).toBe("zenspec");
  expect(estimateTokens(front.description!)).toBeLessThanOrEqual(60);
});

it("mentions only commands and flags that `zenspec help` documents", () => {
  const reference = help();
  const commands = [...skill.matchAll(/`zenspec (\w+)/g)].map((m) => m[1]!);
  expect(new Set(commands)).toEqual(new Set(["review", "help"]));
  for (const command of commands)
    expect(reference).toMatch(new RegExp(`^zenspec ${command}\\b`, "m"));

  const review = help("review");
  for (const flag of new Set([...skill.matchAll(/ (-[a-z]|--[a-z-]+) /g)].map((m) => m[1]!))) {
    expect(review).toContain(flag);
  }
  for (const action of skill.matchAll(/-r <?\w+>?:(\w+)/g)) {
    expect(review).toContain(action[1]!);
  }
});
