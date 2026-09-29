// Product event tracker.
// Queue → batches (every 5 s or 20 events) → POST /api/v1/events; on hide the rest leaves with
// `fetch keepalive`. A session_id per launch, a client_event_id per event (the server drops
// repeats), platform from the MAX Bridge. Best effort: a network failure never reaches the UI.
// No personal data: props are filtered by the same whitelist the server enforces, and a search
// phrase travels only with `search_empty` (the server keeps it just in the empty-search table).

import { readMaxContext } from "../max/bridge";

export type EventName =
  | "app_open" | "menu_view" | "category_view" | "search" | "search_empty" | "item_view"
  | "item_add" | "item_remove" | "choice_shown" | "favorite_add" | "rec_impression" | "rec_click"
  | "ai_ask" | "ai_answer_click" | "share_menu" | "notification_open"
  | "venue_created" | "menu_published" | "import_started" | "import_applied" | "ai_plan_applied";

type Scalar = string | number | boolean | null;

export const ALLOWED_KEYS = [
  "menu_id", "item_key", "item_name", "section_id", "section_name", "query_len", "results",
  "source", "count", "items", "total_minor", "slot", "method", "kind", "available",
] as const;
export type EventProps = Partial<Record<(typeof ALLOWED_KEYS)[number], Scalar>>;
const ALLOWED = new Set<string>(ALLOWED_KEYS);
const NAMES = new Set<string>([
  "app_open", "menu_view", "category_view", "search", "search_empty", "item_view", "item_add",
  "item_remove", "choice_shown", "favorite_add", "rec_impression", "rec_click", "ai_ask",
  "ai_answer_click", "share_menu", "notification_open", "venue_created", "menu_published",
  "import_started", "import_applied", "ai_plan_applied",
]);
/** Older names of the guest bus (`sinitsa:event`) → dictionary names. */
const ALIASES: Record<string, EventName> = { choice_add: "item_add", show_at_cashier: "choice_shown" };

export const FLUSH_MS = 5000;
export const FLUSH_SIZE = 20;
const MAX_BATCH = 50;
const MAX_QUEUE = 200;
const MAX_ATTEMPTS = 3;
const ENDPOINT = "/api/v1/events";

interface QueuedEvent {
  point: string;
  client_event_id: string;
  name: EventName;
  occurred_at: string;
  props: EventProps;
  query?: string;
  attempts: number;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const sessionId = uuid();
let queue: QueuedEvent[] = [];
let timer: number | null = null;
let installed = false;
let sending = false;

export function platform(): "max_ios" | "max_android" | "max_web" | "web" {
  try {
    const context = readMaxContext();
    if (!context.available) return "web";
    if (context.platform === "ios") return "max_ios";
    if (context.platform === "android") return "max_android";
    return "max_web";
  } catch {
    return "web";
  }
}

/** Keeps only whitelisted scalar props (strings ≤ 120). */
export function cleanProps(raw: Record<string, unknown>): EventProps {
  const props: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED.has(key)) continue;
    if (value === null || typeof value === "boolean" || typeof value === "number") props[key] = value;
    else if (typeof value === "string") props[key] = value.slice(0, 120);
  }
  return props as EventProps;
}

/** The cabinet renders the guest menu as a preview; those views are not guests. */
function guestSuppressed(): boolean {
  return typeof window === "undefined" || window.location.pathname.startsWith("/manage");
}

type AdminEvent = "venue_created" | "menu_published" | "import_started" | "import_applied" | "ai_plan_applied";

/** Admin event of the cabinet point in the URL (`/manage/:publicId/...`) or of `point`. */
export function trackAdmin(name: AdminEvent, props: Record<string, unknown> = {}, point?: string): void {
  try {
    const fromUrl = /^\/manage\/([^/]+)/.exec(window.location.pathname)?.[1];
    const target = point ?? (fromUrl ? decodeURIComponent(fromUrl) : "");
    if (target) track(target, name, props);
  } catch {
    // Analytics is best effort.
  }
}

/** Queues one event of a point (`public_id`). `query` is only for `search_empty`. */
export function track(point: string, name: EventName, props: Record<string, unknown> = {}, query?: string): void {
  try {
    if (!point || !NAMES.has(name) || typeof window === "undefined") return;
    const event: QueuedEvent = {
      point,
      client_event_id: uuid(),
      name,
      occurred_at: new Date().toISOString(),
      props: cleanProps(props),
      attempts: 0,
    };
    if (name === "search_empty" && query) event.query = query.slice(0, 100);
    queue.push(event);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    if (queue.length >= FLUSH_SIZE) void flush();
    else schedule();
  } catch {
    // Analytics is best effort.
  }
}

function schedule(): void {
  if (timer !== null || typeof window === "undefined") return;
  timer = window.setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

function body(point: string, events: QueuedEvent[]): string {
  return JSON.stringify({
    point,
    session_id: sessionId,
    platform: platform(),
    events: events.map(({ client_event_id, name, occurred_at, props, query }) =>
      (query ? { client_event_id, name, occurred_at, props, query } : { client_event_id, name, occurred_at, props })),
  });
}

function takeBatches(): [string, QueuedEvent[]][] {
  const byPoint = new Map<string, QueuedEvent[]>();
  for (const event of queue) byPoint.set(event.point, [...(byPoint.get(event.point) ?? []), event]);
  queue = [];
  const batches: [string, QueuedEvent[]][] = [];
  for (const [point, events] of byPoint) {
    for (let index = 0; index < events.length; index += MAX_BATCH) batches.push([point, events.slice(index, index + MAX_BATCH)]);
  }
  return batches;
}

/** Sends everything queued. Failed batches go back (same client_event_id) up to 3 attempts. */
export async function flush(options: { keepalive?: boolean } = {}): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (!queue.length || (sending && !options.keepalive)) return;
  sending = true;
  const failed: QueuedEvent[] = [];
  try {
    for (const [point, events] of takeBatches()) {
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          keepalive: options.keepalive ?? false,
          body: body(point, events),
        });
        // Other 4xx mean the batch itself is refused: a retry cannot help.
        if (!response.ok && (response.status >= 500 || response.status === 429)) failed.push(...events);
      } catch {
        failed.push(...events);
      }
    }
  } finally {
    sending = false;
  }
  const retry = failed.map((event) => ({ ...event, attempts: event.attempts + 1 })).filter((event) => event.attempts < MAX_ATTEMPTS);
  if (retry.length) {
    queue = [...retry, ...queue].slice(-MAX_QUEUE);
    schedule();
  }
}

/** Listens to the guest bus (`sinitsa:event`) and flushes when the mini-app is hidden. */
export function installAnalytics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("sinitsa:event", (raw) => {
    const detail = (raw as CustomEvent<Record<string, unknown>>).detail ?? {};
    const { name, public_id: point, query, ...rest } = detail;
    if (typeof name !== "string" || typeof point !== "string" || guestSuppressed()) return;
    const mapped = (ALIASES[name] ?? name) as EventName;
    track(point, mapped, rest, typeof query === "string" ? query : undefined);
  });
  const hide = () => void flush({ keepalive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hide();
  });
  window.addEventListener("pagehide", hide);
}
