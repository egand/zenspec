/** Handlers for every route in `core/api.ts`. */
import fs from "node:fs";
import path from "node:path";
import type {
  AcceptDriftResponse,
  DraftResponse,
  GateResponse,
  HealthResponse,
  InboxItem,
  InboxPendingResponse,
  InboxResponse,
  KbLookupResponse,
  KbTermsResponse,
  OpenDocResponse,
  SseMessage,
  SubmitReviewResponse,
  UploadAttachmentResponse,
  WaitReviewResponse,
} from "../core/api.js";
import { PAGES, ROUTES, fillPath } from "../core/api.js";
import { gateStatus, latestReview, latestRevision, openThreads } from "../core/reducer.js";
import type { DocumentRef } from "../core/types.js";
import { badRequest, notFound, readBody, readJson, Router } from "./http.js";
import type { RequestContext } from "./http.js";
import { MAX_ATTACHMENT_BYTES, attachmentRef, probeImage } from "./images.js";
import type { KnowledgeBase } from "./kb.js";
import { implementationPayload, pendingPayload, reviewPayload } from "./payloads.js";
import type { Registry } from "./registry.js";
import type { DocSession } from "./session.js";
import * as validate from "./validate.js";

export interface DaemonContext {
  registry: Registry;
  kb: KnowledgeBase;
  pid: number;
  version: string;
  startedAt: string;
  port: () => number;
  /** Stops the daemon once the current response has been sent. */
  requestStop: () => void;
}

const SSE_KEEPALIVE_MS = 25_000;

export function buildRouter(d: DaemonContext): Router {
  const doc = ({ params }: RequestContext) => d.registry.get(params.repoId!, params.docId!);
  const pageUrl = (ref: DocumentRef) =>
    `http://127.0.0.1:${d.port()}${fillPath(PAGES.doc, { repoId: ref.repoId, docId: ref.docId })}`;

  return new Router()
    .add("GET", ROUTES.health, (): HealthResponse => ({
      pid: d.pid,
      port: d.port(),
      version: d.version,
      startedAt: d.startedAt,
    }))
    .add("POST", ROUTES.stop, ({ res }) => {
      res.once("finish", d.requestStop);
      return { ok: true };
    })
    .add("POST", ROUTES.docs, async ({ req }): Promise<OpenDocResponse> => {
      const { path: file } = await readJson(req);
      if (typeof file !== "string" || !path.isAbsolute(file)) {
        throw badRequest("`path` must be an absolute path");
      }
      const { session, created } = await d.registry.open(file);
      return { doc: session.document, url: pageUrl(session.ref), created, viewed: session.viewed };
    })
    .add("GET", ROUTES.doc, (ctx) => doc(ctx).snapshot())
    .add("POST", ROUTES.revisions, async (ctx) =>
      doc(ctx).publish(validate.publishRequest(await readJson(ctx.req))),
    )
    .add("GET", ROUTES.revision, (ctx) => {
      const session = doc(ctx);
      const n = Number(ctx.params.n);
      const content = Number.isInteger(n) ? session.storage.readRevision(n) : null;
      if (content === null) throw notFound(`Unknown revision: ${ctx.params.n}`);
      const type = session.ref.kind === "html" ? "text/html" : "text/markdown";
      ctx.res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      ctx.res.end(content);
    })
    .add("GET", ROUTES.nextReview, (ctx) => waitForReview(ctx, doc(ctx), d.kb))
    .add("POST", ROUTES.reviews, async (ctx): Promise<SubmitReviewResponse> => {
      const request = validate.submitRequest(await readJson(ctx.req));
      return { review: doc(ctx).submit(request) };
    })
    .add("GET", ROUTES.draft, (ctx): DraftResponse => ({ draft: doc(ctx).draft }))
    .add("PUT", ROUTES.draft, async (ctx): Promise<DraftResponse> => {
      const session = doc(ctx);
      session.setDraft(validate.draftRequest(await readJson(ctx.req)));
      return { draft: session.draft };
    })
    .add("POST", ROUTES.thread, async (ctx): Promise<DraftResponse> => {
      const action = validate.threadActionRequest(await readJson(ctx.req));
      return { draft: doc(ctx).stageThreadAction(ctx.params.threadId!, action) };
    })
    .add("POST", ROUTES.attachments, async (ctx): Promise<UploadAttachmentResponse> => {
      const session = doc(ctx);
      const bytes = await readBody(ctx.req, MAX_ATTACHMENT_BYTES);
      const info = probeImage(bytes);
      if (!info) throw badRequest("Expected a PNG, JPEG or WebP image");
      const ref = attachmentRef(bytes, info);
      session.storage.writeAttachment(ref.id, ref.mime, bytes);
      return ref;
    })
    .add("GET", ROUTES.attachment, (ctx) => {
      const found = doc(ctx).storage.findAttachment(ctx.params.attachmentId!);
      if (!found) throw notFound(`Unknown attachment: ${ctx.params.attachmentId}`);
      const body = fs.readFileSync(found.path);
      ctx.res.writeHead(200, {
        "Content-Type": found.mime,
        "Content-Length": body.length,
        "Cache-Control": "private, max-age=31536000, immutable",
      });
      ctx.res.end(body);
    })
    .add("POST", ROUTES.close, async (ctx) => {
      const session = doc(ctx);
      session.close(validate.closeRequest(await readJson(ctx.req)));
      return { doc: session.document };
    })
    .add("POST", ROUTES.acceptDrift, (ctx): AcceptDriftResponse => {
      const session = doc(ctx);
      session.acceptDrift();
      return { doc: session.document };
    })
    .add("GET", ROUTES.events, (ctx) => streamEvents(ctx, doc(ctx)))
    .add("GET", ROUTES.inbox, ({ query }): InboxResponse => {
      const repo = query.get("repo");
      const sessions = repo ? d.registry.inRepoOf(repo) : d.registry.all();
      return { items: sessions.flatMap((s) => inboxItem(s, pageUrl(s.ref)) ?? []) };
    })
    .add("POST", ROUTES.inboxPending, async ({ req }): Promise<InboxPendingResponse> => {
      const { repo } = await readJson(req);
      if (typeof repo !== "string" || !repo) throw badRequest("`repo` is required");
      const items: InboxPendingResponse["items"] = [];
      for (const session of d.registry.inRepoOf(repo)) {
        const { phase } = session.state;
        if (phase !== "approved" && phase !== "implementing") continue;
        const found = implementationPayload(session, session.storage.readDelivered(), d.kb);
        if (!found) continue;
        session.storage.writeDelivered(found.lastReview);
        if (found.payload) items.push({ doc: session.ref, payload: found.payload });
      }
      return { items };
    })
    .add("GET", ROUTES.gate, ({ query }): GateResponse => {
      const file = query.get("path");
      const repo = query.get("repo");
      if (file) {
        const session = d.registry.find(file);
        if (!session) throw notFound(`Not under review: ${file}`);
        const { approved, phase } = gateStatus(session.state);
        return { approved, blocking: approved ? [] : [{ doc: session.ref, phase }] };
      }
      if (!repo) throw badRequest("Pass `path` or `repo`");
      const blocking = d.registry
        .inRepoOf(repo)
        .filter((s) => isOpenReview(s) && !gateStatus(s.state).approved)
        .map((s) => ({ doc: s.ref, phase: s.state.phase }));
      return { approved: blocking.length === 0, blocking };
    })
    .add("GET", ROUTES.kbLookup, ({ query }): KbLookupResponse => {
      const term = query.get("term");
      if (!term) throw badRequest("`term` is required");
      return { configured: d.kb.configured, note: d.kb.lookup(term) };
    })
    .add("GET", ROUTES.kbTerms, (): KbTermsResponse => ({ notes: d.kb.list() }));
}

/** Published and not closed: the document is part of an ongoing review. */
function isOpenReview(session: DocSession): boolean {
  return session.state.revisions.length > 0 && !session.state.closed;
}

function inboxItem(session: DocSession, url: string): InboxItem | null {
  const { state } = session;
  if (!isOpenReview(session) || state.phase === "done") return null;
  const review = latestReview(state);
  return {
    doc: session.document,
    url,
    lastRevision: latestRevision(state)?.n ?? 0,
    lastReview: review?.n ?? 0,
    ...(review && { lastVerdict: review.verdict }),
    openThreads: openThreads(state).length,
    updatedAt: session.updatedAt ?? "",
  };
}

async function waitForReview(
  { req, res, query }: RequestContext,
  session: DocSession,
  kb: KnowledgeBase,
): Promise<WaitReviewResponse> {
  const after = validate.intParam(query, "after");
  if (after === undefined) throw badRequest("`after` is required");
  const timeoutMs = validate.intParam(query, "timeoutMs");
  const abort = new AbortController();
  res.once("close", () => abort.abort());
  req.socket.setTimeout(0);
  const outcome = await session.wait(after, timeoutMs, abort.signal);
  switch (outcome.kind) {
    case "review":
      return { status: "delivered", payload: reviewPayload(session, outcome.review, kb) };
    case "closed":
      return { status: "closed", by: outcome.by, reason: outcome.reason };
    case "timeout":
      return { status: "pending", payload: pendingPayload(session, timeoutMs) };
  }
}

function streamEvents({ res }: RequestContext, session: DocSession): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const send = ({ event, data }: SseMessage) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const unsubscribe = session.subscribe(send);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), SSE_KEEPALIVE_MS);
  res.once("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
}
