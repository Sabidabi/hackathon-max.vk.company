// Safe wrappers over the MAX Bridge.
// Contract: no function here throws or rejects — inside MAX they call the Bridge, and when a
// method is missing, fails, or the app runs in a browser they take the documented fallback.

import { showToast } from "../design/toast";
import {
  getMaxBridge,
  type HapticImpactStyle,
  type HapticNotificationType,
  type MaxShareContent,
} from "./bridge";

type Settled<T> = { ok: true; value: T } | { ok: false; error?: unknown };

/** Calls a Bridge method that may return a value or a promise, or throw. */
async function settle<T>(call: () => T | Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The person closed the share sheet (Web Share `AbortError`, or a «cancel» error). */
function isCancel(result: Settled<unknown>): boolean {
  if (result.ok || !result.error) return false;
  const error = result.error as { name?: unknown; message?: unknown; code?: unknown };
  if (error.name === "AbortError") return true;
  return [error.message, error.code, result.error].some(
    (value) => typeof value === "string" && /cancel|abort|dismiss/i.test(value),
  );
}

function fireAndForget(call: () => unknown): boolean {
  try {
    const result = call();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

/** Bridge results arrive as a plain string or as `{ value }` / `{ data }` / `{ result }`. */
function stringResult(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["value", "data", "result"] as const) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "string") return candidate;
    }
  }
  return null;
}

// --- Lifecycle --------------------------------------------------------------------------

let readySent = false;

/** Tells MAX the first screen is drawn (hides the MAX splash). Idempotent. */
export function ready(): void {
  if (readySent) return;
  const bridge = getMaxBridge();
  if (!bridge?.ready) return;
  readySent = fireAndForget(() => bridge.ready?.());
}

/** Asks for confirmation before the mini app closes (unsaved cabinet edits, running uploads). */
export function closingConfirmation(enabled: boolean): void {
  const bridge = getMaxBridge();
  const method = enabled ? bridge?.enableClosingConfirmation : bridge?.disableClosingConfirmation;
  if (bridge && method && fireAndForget(() => method.call(bridge))) return;
  if (typeof window === "undefined") return;
  // Browser fallback: the standard «leave page?» prompt.
  window.removeEventListener("beforeunload", preventUnload);
  if (enabled) window.addEventListener("beforeunload", preventUnload);
}

function preventUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
}

// --- Haptics ----------------------------------------------------------------------------

/** Tactile feedback; silently does nothing outside MAX or on clients without haptics. */
export const haptics = {
  impact(style: HapticImpactStyle = "light"): void {
    const feedback = getMaxBridge()?.HapticFeedback;
    if (feedback?.impactOccurred) fireAndForget(() => feedback.impactOccurred?.(style));
  },
  selection(): void {
    const feedback = getMaxBridge()?.HapticFeedback;
    if (feedback?.selectionChanged) fireAndForget(() => feedback.selectionChanged?.());
  },
  notify(type: HapticNotificationType): void {
    const feedback = getMaxBridge()?.HapticFeedback;
    if (feedback?.notificationOccurred) fireAndForget(() => feedback.notificationOccurred?.(type));
  },
};

// --- Sharing ----------------------------------------------------------------------------

export type ShareResult = "max" | "system" | "copied" | "cancelled" | "failed";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (webviews without clipboard permission).
  }
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * Share a menu or an invitation: `shareMaxContent` (chats in MAX) → `shareContent`
 * (system sheet; absent on desktop) → copy the link and show «Ссылка скопирована».
 * A sheet closed by the person resolves to "cancelled" and copies nothing.
 */
export async function share(content: MaxShareContent): Promise<ShareResult> {
  const bridge = getMaxBridge();
  if (bridge?.shareMaxContent) {
    const result = await settle(() => bridge.shareMaxContent?.(content));
    if (result.ok) return "max";
    if (isCancel(result)) return "cancelled";
  }
  if (bridge?.shareContent) {
    const result = await settle(() => bridge.shareContent?.(content));
    if (result.ok) return "system";
    if (isCancel(result)) return "cancelled";
  }
  const text = content.link ?? content.text ?? "";
  if (text && (await copyText(text))) {
    showToast(content.link ? "Ссылка скопирована" : "Текст скопирован");
    return "copied";
  }
  showToast("Не удалось поделиться. Скопируйте ссылку вручную.");
  return "failed";
}

// --- QR scanner -------------------------------------------------------------------------

/** Opens the MAX QR scanner. Resolves to the scanned text, or null when unavailable/cancelled. */
export async function scanQr(): Promise<string | null> {
  const bridge = getMaxBridge();
  if (!bridge?.openCodeReader) return null;
  const result = await settle(() => bridge.openCodeReader?.(false));
  return result.ok ? stringResult(result.value) : null;
}

/** True when `scanQr()` can open a scanner (the caller hides or explains the button otherwise). */
export function canScanQr(): boolean {
  return Boolean(getMaxBridge()?.openCodeReader);
}

// --- Links and files --------------------------------------------------------------------

function openInBrowser(url: string): void {
  try {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) window.location.assign(url);
  } catch {
    // Nothing else we can do without a window.
  }
}

/** Opens a MAX deep link (`https://max.ru/...`) inside MAX, or in a new tab outside it. */
export function openMaxLink(url: string): void {
  const bridge = getMaxBridge();
  if (bridge?.openMaxLink && fireAndForget(() => bridge.openMaxLink?.(url))) return;
  openInBrowser(url);
}

/** Opens an external link (map, venue site) in the MAX in-app browser or a new tab. */
export function openLink(url: string): void {
  const bridge = getMaxBridge();
  if (bridge?.openLink && fireAndForget(() => bridge.openLink?.(url))) return;
  openInBrowser(url);
}

/** Downloads a file (QR, table tent): MAX `downloadFile`, otherwise `<a download>`. */
export async function downloadFile(url: string, fileName: string): Promise<void> {
  const bridge = getMaxBridge();
  if (bridge?.downloadFile && (await settle(() => bridge.downloadFile?.(url, fileName))).ok) return;
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  } catch {
    openInBrowser(url);
  }
}

// --- Screen brightness («Показать на кассе») ----------------------------------------------

/** Raises screen brightness in MAX. Returns false when unsupported (no fallback in a browser). */
export async function boostBrightness(): Promise<boolean> {
  const bridge = getMaxBridge();
  if (!bridge?.requestScreenMaxBrightness) return false;
  return (await settle(() => bridge.requestScreenMaxBrightness?.())).ok;
}

export async function restoreBrightness(): Promise<void> {
  const bridge = getMaxBridge();
  if (bridge?.restoreScreenBrightness) await settle(() => bridge.restoreScreenBrightness?.());
}

// --- Device storage (recent venues, «Мой выбор» draft; never secrets) ----------------------

function localGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the feature just forgets between launches.
  }
}

/** MAX `DeviceStorage` with a `localStorage` fallback. Never rejects. */
export const deviceStorage = {
  async getItem(key: string): Promise<string | null> {
    const storage = getMaxBridge()?.DeviceStorage;
    if (storage?.getItem) {
      const result = await settle(() => storage.getItem?.(key));
      if (result.ok) return stringResult(result.value);
    }
    return localGet(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    const storage = getMaxBridge()?.DeviceStorage;
    if (storage?.setItem && (await settle(() => storage.setItem?.(key, value))).ok) return;
    localSet(key, value);
  },
  async removeItem(key: string): Promise<void> {
    const storage = getMaxBridge()?.DeviceStorage;
    if (storage?.removeItem && (await settle(() => storage.removeItem?.(key))).ok) return;
    localSet(key, null);
  },
};
