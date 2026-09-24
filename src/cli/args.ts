import { parseArgs, type ParseArgsConfig } from "node:util";
import { parse as parseYaml } from "yaml";
import type { Response, ResponseAction } from "../core/types.js";
import { usageError } from "./errors.js";

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Strict `parseArgs` whose failures become usage errors. */
export function parse<const O extends Options>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw usageError((err as Error).message);
  }
}

/** Between `min` and `max` positionals, or a usage error showing `usage`. */
export function positionals(values: string[], min: number, max: number, usage: string): string[] {
  if (values.length < min || values.length > max) throw usageError(`usage: ${usage}`);
  return values;
}

const ACTIONS: readonly ResponseAction[] = ["edited", "answered", "declined"];

function response(thread: unknown, action: unknown, note: unknown, source: string): Response {
  if (typeof thread !== "string" || !thread) throw usageError(`${source}: missing thread id`);
  if (!ACTIONS.includes(action as ResponseAction)) {
    throw usageError(`${source}: action must be one of ${ACTIONS.join("|")}`);
  }
  if (note !== undefined && note !== null && typeof note !== "string") {
    throw usageError(`${source}: note must be a string`);
  }
  return { thread, action: action as ResponseAction, ...(note ? { note } : {}) };
}

/** `<id>:<action>[:<note>]`; only the first two colons split, so notes may contain colons. */
export function parseResponseFlag(value: string): Response {
  const first = value.indexOf(":");
  const second = first < 0 ? -1 : value.indexOf(":", first + 1);
  if (first < 0) throw usageError(`-r ${value}: expected <id>:<action>[:<note>]`);
  const thread = value.slice(0, first);
  const action = second < 0 ? value.slice(first + 1) : value.slice(first + 1, second);
  const note = second < 0 ? undefined : value.slice(second + 1);
  return response(thread, action, note, `-r ${value}`);
}

/** YAML list of `{thread, action, note}`; an empty document means no responses. */
export function parseResponsesYaml(text: string, source: string): Response[] {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw usageError(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data))
    throw usageError(`${source}: expected a list of {thread, action, note}`);
  return data.map((item: unknown, i) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    return response(entry.thread, entry.action, entry.note, `${source}[${i}]`);
  });
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `1500ms`, `30s`, `10m`, `1h`; a bare number is seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) throw usageError(`--wait ${value}: expected a duration like 30s, 10m, or 1h`);
  return Math.round(Number(match[1]) * UNITS[match[2] ?? "s"]);
}
