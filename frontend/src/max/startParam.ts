// Parser for the MAX `startapp` payload (P1-DOC-12 «Диплинки», P1-DOC-4 «Маршрутизация»).
// The payload is navigation only: it never grants access, the server checks every right.
// Kept free of imports so `tests/max-layer.unit.mjs` can load it with Node type stripping.

export type StartTarget =
  | { kind: "menu"; publicId: string }
  | { kind: "item"; publicId: string; itemId: string }
  | { kind: "manage"; publicId: string; section?: ManageSection }
  | { kind: "invite"; token: string }
  | { kind: "connect" }
  | { kind: "settings" };

/** Cabinet screens a bot button may open: `manage_<publicId>_s_<section>` (P1-DOC-11). */
export type ManageSection = "menu" | "analytics" | "team" | "import" | "messages" | "notifications";
const MANAGE_SECTION = /^manage_([A-Za-z0-9_-]+)_s_(menu|analytics|team|import|messages|notifications)$/;
const MANAGE_PATHS: Record<ManageSection, string> = {
  menu: "menu",
  analytics: "analytics",
  team: "more/team",
  import: "more/import",
  messages: "more/messages",
  notifications: "more/notifications",
};

export const START_PARAM_MAX_LENGTH = 512;
const SAFE_PAYLOAD = /^[A-Za-z0-9_-]+$/;
const ITEM = /^r_([A-Za-z0-9_-]+)_i_([A-Za-z0-9-]+)$/;
const MENU = /^r_([A-Za-z0-9_-]+)$/;
const MANAGE = /^manage_([A-Za-z0-9_-]+)$/;
const INVITE = /^inv_([A-Za-z0-9_-]{30,128})$/;

/**
 * Returns null for an empty, oversized, unsafe or unknown payload — the caller opens Home.
 * No trimming: a payload with spaces (`r_<id>%20x`, ` r_<id>`) is broken and rejected whole
 * (P1-DOC-12 «Валидный стартовый параметр»).
 */
export function parseStartParam(raw: string | null | undefined): StartTarget | null {
  if (typeof raw !== "string") return null;
  const payload = raw;
  if (!payload || payload.length > START_PARAM_MAX_LENGTH || !SAFE_PAYLOAD.test(payload)) return null;
  if (payload === "connect") return { kind: "connect" };
  if (payload === "settings") return { kind: "settings" };
  const item = ITEM.exec(payload);
  if (item) return { kind: "item", publicId: item[1], itemId: item[2] };
  const menu = MENU.exec(payload);
  if (menu) return { kind: "menu", publicId: menu[1] };
  const section = MANAGE_SECTION.exec(payload);
  if (section) return { kind: "manage", publicId: section[1], section: section[2] as ManageSection };
  const manage = MANAGE.exec(payload);
  if (manage) return { kind: "manage", publicId: manage[1] };
  const invite = INVITE.exec(payload);
  if (invite) return { kind: "invite", token: invite[1] };
  return null;
}

/** In-app path for a parsed start target. */
export function startTargetPath(target: StartTarget): string {
  switch (target.kind) {
    case "menu":
      return `/r/${target.publicId}`;
    case "item":
      return `/r/${target.publicId}/i/${target.itemId}`;
    case "manage":
      return target.section ? `/manage/${target.publicId}/${MANAGE_PATHS[target.section]}` : `/manage/${target.publicId}`;
    case "invite":
      return `/invite/${target.token}`;
    case "connect":
      return "/connect";
    case "settings":
      return "/notifications";
  }
}

const APP_PATH = /^\/(?:r\/[A-Za-z0-9_-]{1,120}(?:\/i\/[A-Za-z0-9-]{1,64})?|invite\/[A-Za-z0-9_-]{30,128})\/?$/;

/**
 * In-app path for text read by the QR scanner on Home, or null when it is not ours:
 * - a MAX deep link `https://max.ru/<bot>?startapp=<payload>`;
 * - a link to this app (`<origin>/r/<id>`, `/r/<id>/i/<item>`, `/invite/<token>`);
 * - a bare start payload (`r_<id>`).
 * Other hosts are rejected: a QR must not steer the app to someone else's page.
 */
export function scannedTargetPath(text: string | null | undefined, appOrigin: string): string | null {
  if (typeof text !== "string" || !text || text.length > 2048) return null;
  const direct = parseStartParam(text);
  if (direct) return startTargetPath(direct);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const startapp = url.searchParams.get("startapp");
  if (url.hostname === "max.ru" || url.hostname.endsWith(".max.ru")) {
    const target = parseStartParam(startapp);
    return target ? startTargetPath(target) : null;
  }
  if (url.origin !== appOrigin) return null;
  if (startapp !== null) {
    const target = parseStartParam(startapp);
    return target ? startTargetPath(target) : null;
  }
  return APP_PATH.test(url.pathname) ? url.pathname.replace(/\/$/, "") : null;
}
