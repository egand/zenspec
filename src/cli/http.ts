/**
 * Minimal JSON client for the daemon API (`src/core/api.ts`). Uses `node:http` rather than
 * `fetch` because a review long-poll can outlive undici's default header timeout.
 */
import http from "node:http";
import type { ApiError } from "../core/api.js";
import { ApiRequestError, UnreachableError } from "./errors.js";

export type Query = Record<string, string | number | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Socket inactivity timeout; none by default (long-polls). */
  timeoutMs?: number;
}

export class DaemonClient {
  constructor(readonly port: number) {}

  get<T>(route: string, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request("GET", route, options);
  }

  post<T>(route: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request("POST", route, { ...options, body });
  }

  request<T>(method: string, route: string, options: RequestOptions = {}): Promise<T> {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          method,
          path: route + queryString(options.query),
          agent: false,
          headers: payload ? { "content-type": "application/json" } : {},
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("error", (err) => reject(unreachable(err)));
          res.on("end", () => {
            if (!res.complete) return reject(unreachable(new Error("connection dropped")));
            const status = res.statusCode ?? 0;
            const data = parseJson(text);
            if (status >= 200 && status < 300) return resolve(data as T);
            const message = (data as ApiError | undefined)?.error?.message ?? `HTTP ${status}`;
            reject(new ApiRequestError(status, message));
          });
        },
      );
      if (options.timeoutMs !== undefined) {
        req.setTimeout(options.timeoutMs, () => req.destroy(new Error("timed out")));
      }
      req.on("error", (err) => reject(unreachable(err)));
      req.end(payload);
    });
  }
}

function unreachable(err: Error): UnreachableError {
  return new UnreachableError(`daemon unreachable: ${err.message}`);
}

function queryString(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
