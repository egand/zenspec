/**
 * Shape checks for request bodies. They reject what would corrupt the log, not every
 * possible inconsistency: the reducer already ignores transitions that do not apply.
 */
import type {
  CloseRequest,
  PublishRequest,
  SubmitReviewRequest,
  ThreadActionRequest,
} from "../core/api.js";
import type { AttachmentRef, Draft, Response, Verdict } from "../core/types.js";
import { badRequest } from "./http.js";

type Json = Record<string, unknown>;

const VERDICTS: readonly Verdict[] = ["approved", "changes_requested", "comment"];
const RESPONSE_ACTIONS = ["edited", "answered", "declined"];
const THREAD_KINDS = ["comment", "suggestion", "decision", "explain", "general"];

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

function field<T>(body: Json, key: string, check: (v: unknown) => boolean, what: string): T {
  if (!check(body[key])) throw badRequest(`\`${key}\` must be ${what}`);
  return body[key] as T;
}

function optional<T>(body: Json, key: string, check: (v: unknown) => boolean, what: string) {
  return body[key] === undefined ? undefined : field<T>(body, key, check, what);
}

function arrayOf(check: (v: unknown) => boolean) {
  return (v: unknown) => Array.isArray(v) && v.every(check);
}

const isAttachment = (v: unknown) => isObject(v) && isString(v.id) && isString(v.mime);
const attachments = (body: Json): AttachmentRef[] =>
  optional<AttachmentRef[]>(body, "attachments", arrayOf(isAttachment), "an attachment list") ?? [];

function isResponse(v: unknown): boolean {
  return (
    isObject(v) &&
    isString(v.thread) &&
    RESPONSE_ACTIONS.includes(v.action as string) &&
    (v.note === undefined || isString(v.note))
  );
}

/** A thread spec as the browser sends it: its kind plus the kind's fields. */
function isThreadSpec(v: unknown): boolean {
  if (!isObject(v) || !THREAD_KINDS.includes(v.kind as string)) return false;
  if (v.kind !== "general" && !(isObject(v.anchor) && isString(v.anchor.type))) return false;
  if (v.kind === "suggestion") return isString(v.old) && isString(v.new);
  if (v.kind === "decision") return isString(v.question) && isObject(v.choice);
  if (v.kind === "explain") return isString(v.term) && v.term.trim() !== "";
  return true;
}

const isNewThread = (v: unknown) =>
  isThreadSpec(v) && isString((v as Json).body) && arrayOf(isAttachment)((v as Json).attachments);

export function publishRequest(body: Json): PublishRequest {
  return {
    summary: optional<string>(body, "summary", isString, "a string"),
    responses: optional<Response[]>(body, "responses", arrayOf(isResponse), "a response list"),
    author: optional<string>(body, "author", isString, "a string"),
  };
}

export function submitRequest(body: Json): SubmitReviewRequest {
  const isReopen = (v: unknown) =>
    isObject(v) && isString(v.id) && isString(v.body) && arrayOf(isAttachment)(v.attachments);
  return {
    revision: field(body, "revision", Number.isInteger, "an integer"),
    verdict: field(body, "verdict", (v) => VERDICTS.includes(v as Verdict), VERDICTS.join("|")),
    summary: optional<string>(body, "summary", isString, "a string") ?? "",
    opened: optional(body, "opened", arrayOf(isNewThread), "a thread list") ?? [],
    reopened: optional(body, "reopened", arrayOf(isReopen), "a reopen list") ?? [],
    resolved: optional(body, "resolved", arrayOf(isString), "a thread id list") ?? [],
  };
}

export function draftRequest(body: Json): Draft {
  const isDraftThread = (v: unknown) =>
    isThreadSpec(v) && isString((v as Json).draftId) && isString((v as Json).body);
  const isDraftReopen = (v: unknown) => isObject(v) && isString(v.thread) && isString(v.body);
  field(body, "revision", Number.isInteger, "an integer");
  field(body, "threads", arrayOf(isDraftThread), "a draft thread list");
  field(body, "reopen", arrayOf(isDraftReopen), "a reopen list");
  field(body, "resolve", arrayOf(isString), "a thread id list");
  optional(body, "summary", isString, "a string");
  optional(body, "verdict", (v) => VERDICTS.includes(v as Verdict), VERDICTS.join("|"));
  return { summary: "", ...body } as unknown as Draft;
}

export function threadActionRequest(body: Json): ThreadActionRequest {
  switch (body.action) {
    case "resolve":
    case "unstage":
      return { action: body.action };
    case "reopen":
      return {
        action: "reopen",
        body: field(body, "body", isString, "a string"),
        attachments: attachments(body),
      };
    default:
      throw badRequest("`action` must be resolve|reopen|unstage");
  }
}

export function closeRequest(body: Json): CloseRequest {
  return {
    reason: optional<string>(body, "reason", isString, "a string"),
    by: optional<string>(body, "by", isString, "a string"),
  };
}

/** A non-negative integer query parameter, or `undefined` when absent. */
export function intParam(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest(`\`${name}\` must be a non-negative integer`);
  }
  return value;
}
