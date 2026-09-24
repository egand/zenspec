/** Typed HTTP client for the daemon routes in `core/api.ts`. The browser talks to nothing else. */
import type {
  AcceptDriftResponse,
  ApiError,
  DocStateResponse,
  DraftResponse,
  InboxResponse,
  KbTermsResponse,
  SubmitReviewRequest,
  SubmitReviewResponse,
  UploadAttachmentResponse,
} from "../../core/api.js";
import { ROUTES, fillPath } from "../../core/api.js";
import type { AttachmentId, Draft } from "../../core/types.js";

export interface DocAddress {
  repoId: string;
  docId: string;
}

/** A failed request, carrying the daemon's error code when it sent one. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Api {
  docState(): Promise<DocStateResponse>;
  saveDraft(draft: Draft): Promise<DraftResponse>;
  submitReview(request: SubmitReviewRequest): Promise<SubmitReviewResponse>;
  acceptDrift(): Promise<AcceptDriftResponse>;
  revisionText(n: number): Promise<string>;
  uploadAttachment(image: Blob): Promise<UploadAttachmentResponse>;
  attachmentUrl(id: AttachmentId): string;
  eventsUrl(): string;
  kbTerms(): Promise<KbTermsResponse>;
}

async function request(fetchImpl: typeof fetch, url: string, init?: RequestInit) {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    const { code, message } = body?.error ?? { code: "internal", message: res.statusText };
    throw new RequestError(res.status, code, message);
  }
  return res;
}

async function json<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  return (await request(fetchImpl, url, init)).json() as Promise<T>;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function createApi(doc: DocAddress, fetchImpl: typeof fetch = fetch.bind(globalThis)): Api {
  const path = (route: string, extra: Record<string, string | number> = {}) =>
    fillPath(route, { ...doc, ...extra });
  return {
    docState: () => json(fetchImpl, path(ROUTES.doc)),
    saveDraft: (draft) => json(fetchImpl, path(ROUTES.draft), jsonInit("PUT", draft)),
    submitReview: (req) => json(fetchImpl, path(ROUTES.reviews), jsonInit("POST", req)),
    acceptDrift: () => json(fetchImpl, path(ROUTES.acceptDrift), { method: "POST" }),
    revisionText: async (n) => (await request(fetchImpl, path(ROUTES.revision, { n }))).text(),
    uploadAttachment: (image) =>
      json(fetchImpl, path(ROUTES.attachments), {
        method: "POST",
        headers: { "Content-Type": image.type || "application/octet-stream" },
        body: image,
      }),
    attachmentUrl: (attachmentId) => path(ROUTES.attachment, { attachmentId }),
    eventsUrl: () => path(ROUTES.events),
    kbTerms: () => json(fetchImpl, ROUTES.kbTerms),
  };
}

export function fetchInbox(fetchImpl: typeof fetch = fetch.bind(globalThis)) {
  return json<InboxResponse>(fetchImpl, ROUTES.inbox);
}
