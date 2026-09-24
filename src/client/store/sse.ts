/** Per-document SSE subscription with reconnect backoff (plan §13). */
import { SSE_EVENTS, type SseMessage } from "../../core/api.js";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export interface SseHandlers {
  onMessage(message: SseMessage): void;
  /** Called on every successful (re)connect: the moment to resync state. */
  onOpen(): void;
  onStatus?(status: ConnectionStatus): void;
}

export interface SseOptions {
  EventSourceImpl?: typeof EventSource;
  /** Delay before reconnect attempt `n` (0-based). */
  backoff?: (attempt: number) => number;
}

export const defaultBackoff = (attempt: number) => Math.min(10_000, 500 * 2 ** attempt);

/** Opens the stream and keeps it open. Returns a function that closes it for good. */
export function subscribe(url: string, handlers: SseHandlers, options: SseOptions = {}) {
  const Impl = options.EventSourceImpl ?? globalThis.EventSource;
  const backoff = options.backoff ?? defaultBackoff;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const connect = () => {
    handlers.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    const es = new Impl(url);
    source = es;
    es.onopen = () => {
      attempt = 0;
      handlers.onStatus?.("open");
      handlers.onOpen();
    };
    es.onerror = () => {
      // Take over from the browser's own retry so every reconnect goes through a resync.
      es.close();
      if (closed) return;
      handlers.onStatus?.("reconnecting");
      timer = setTimeout(connect, backoff(attempt++));
    };
    for (const event of Object.values(SSE_EVENTS)) {
      es.addEventListener(event, (e) => {
        const data = JSON.parse((e as MessageEvent<string>).data);
        handlers.onMessage({ event, data } as SseMessage);
      });
    }
  };

  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}
