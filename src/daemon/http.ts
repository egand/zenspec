/**
 * Minimal `node:http` plumbing: a route table compiled from `ROUTES`, JSON helpers, and
 * `ApiError` responses.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiError, ApiErrorCode } from "../core/api.js";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  internal: 500,
};

export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export const badRequest = (message: string) => new HttpError("bad_request", message);
export const notFound = (message: string) => new HttpError("not_found", message);
export const conflict = (message: string) => new HttpError("conflict", message);

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

export function sendError(res: ServerResponse, err: unknown): void {
  const error =
    err instanceof HttpError ? err : new HttpError("internal", (err as Error)?.message ?? "error");
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body: ApiError = { error: { code: error.code, message: error.message } };
  sendJson(res, error.status, body);
}

/** Reads the whole request body, failing with 413 past `limit` bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError("too_large", `Body exceeds ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError("too_large", `Body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const JSON_LIMIT = 2 * 1024 * 1024;

/** Parses a JSON object body; an empty body is `{}`. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, JSON_LIMIT)).toString("utf8");
  if (!raw.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw badRequest("Invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

/** Returns a JSON body to send with 200, or `undefined` when the handler responded itself. */
export type Handler = (ctx: RequestContext) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, template: string, handler: Handler): this {
    const source = template
      .split("/")
      .map((part) => (part.startsWith(":") ? `(?<${part.slice(1)}>[^/]+)` : escape(part)))
      .join("/");
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(m.groups ?? {})) {
        try {
          params[key] = decodeURIComponent(value);
        } catch {
          throw badRequest(`Malformed path parameter: ${key}`);
        }
      }
      return { handler: route.handler, params };
    }
    throw pathMatched
      ? badRequest(`Method ${method} not allowed on ${pathname}`)
      : notFound(`No route for ${pathname}`);
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
