/** Which page the daemon served: a document review or the inbox (`PAGES` in `core/api.ts`). */
import { PAGES } from "../../core/api.js";
import type { DocAddress } from "../store/api.js";

export type Route = { page: "doc"; address: DocAddress } | { page: "inbox" } | { page: "unknown" };

export function parseRoute(pathname: string): Route {
  const doc = /^\/d\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (doc) {
    return {
      page: "doc",
      address: { repoId: decodeURIComponent(doc[1]!), docId: decodeURIComponent(doc[2]!) },
    };
  }
  if (pathname.replace(/\/$/, "") === PAGES.inbox) return { page: "inbox" };
  return { page: "unknown" };
}
