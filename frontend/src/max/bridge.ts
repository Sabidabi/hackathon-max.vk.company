export type MaxPlatform = "ios" | "android" | "desktop" | "web" | "unknown";

export type HapticImpactStyle = "soft" | "light" | "medium" | "heavy" | "rigid";
export type HapticNotificationType = "success" | "warning" | "error";

// Optional MAX Bridge surface (dev.max.ru/docs/webapps/bridge). Every member is optional:
// older clients and the desktop/web client lack some methods, and outside MAX the script
// may define `window.WebApp` without a host to talk to. Call through `max/platform.ts`.
export interface MaxBackButton {
  isVisible?: boolean;
  show?: () => unknown;
  hide?: () => unknown;
  onClick?: (handler: () => void) => unknown;
  offClick?: (handler: () => void) => unknown;
}

export interface MaxHapticFeedback {
  impactOccurred?: (style: HapticImpactStyle, disableVibrationFallback?: boolean) => unknown;
  notificationOccurred?: (type: HapticNotificationType, disableVibrationFallback?: boolean) => unknown;
  selectionChanged?: (disableVibrationFallback?: boolean) => unknown;
}

export interface MaxDeviceStorage {
  setItem?: (key: string, value: string) => unknown;
  getItem?: (key: string) => unknown;
  removeItem?: (key: string) => unknown;
}

export interface MaxShareContent {
  text?: string;
  link?: string;
}

export interface MaxWebApp {
  initData?: string;
  initDataUnsafe?: { start_param?: string };
  platform?: Exclude<MaxPlatform, "unknown">;
  version?: string;
  ready?: () => void;
  expand?: () => void;
  BackButton?: MaxBackButton;
  HapticFeedback?: MaxHapticFeedback;
  DeviceStorage?: MaxDeviceStorage;
  openLink?: (url: string) => unknown;
  openMaxLink?: (url: string) => unknown;
  shareContent?: (content: MaxShareContent) => unknown;
  shareMaxContent?: (content: MaxShareContent) => unknown;
  downloadFile?: (url: string, fileName: string) => unknown;
  openCodeReader?: (fileSelect?: boolean) => unknown;
  requestScreenMaxBrightness?: () => unknown;
  restoreScreenBrightness?: () => unknown;
  enableClosingConfirmation?: () => unknown;
  disableClosingConfirmation?: () => unknown;
}

declare global {
  interface Window {
    WebApp?: MaxWebApp;
  }
}

export interface MaxContext {
  available: boolean;
  initData: string;
  platform: MaxPlatform;
  version: string | null;
  startParam: string | null;
}

const BRIDGE_WAIT_MS = 2_000;
const BRIDGE_POLL_MS = 50;
let preparedBridge: MaxWebApp | null = null;
let launchedInMax = false;

function readLaunchFragment(): { initData: string; platform: MaxPlatform; version: string | null } {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  // MAX requires every outer launch parameter to be unique. The backend also
  // checks duplicate fields inside signed WebAppData before creating a session.
  const keys = Array.from(fragment.keys());
  if (fragment.getAll("WebAppData").length !== 1 || new Set(keys).size !== keys.length) {
    return { initData: "", platform: "unknown", version: null };
  }
  const platform = fragment.get("WebAppPlatform");
  return {
    initData: fragment.get("WebAppData")?.trim() ?? "",
    platform: platform === "ios" || platform === "android" || platform === "desktop" || platform === "web"
      ? platform
      : "unknown",
    version: fragment.get("WebAppVersion"),
  };
}

export function readMaxContext(): MaxContext {
  const bridge = window.WebApp;
  const fragment = readLaunchFragment();
  const initData = bridge?.initData?.trim() || fragment.initData;
  // This value only selects a public menu. Authentication always uses signed initData.
  const startParam = (initData && new URLSearchParams(initData).get("start_param"))
    || bridge?.initDataUnsafe?.start_param
    || new URLSearchParams(window.location.search).get("WebAppStartParam")
    || null;
  if (!initData) {
    return { available: false, initData: "", platform: "unknown", version: null, startParam };
  }
  return {
    available: true,
    initData,
    platform: bridge?.platform ?? fragment.platform,
    version: bridge?.version ?? fragment.version,
    startParam,
  };
}

function prepareBridge(): void {
  const bridge = window.WebApp;
  if (!bridge || bridge === preparedBridge) return;
  preparedBridge = bridge;
  try {
    bridge.expand?.();
  } catch {
    // Display methods are optional; signed login still proceeds on the server.
  }
  // `ready()` is sent by `max/platform.ts` after the first render (P1-DOC-12 «Сигнал готовности»).
}

export function initializeMaxBridge(): MaxContext {
  const context = readMaxContext();
  if (context.available) {
    launchedInMax = true;
    prepareBridge();
  }
  return context;
}

/**
 * The Bridge object only when the app really runs inside MAX. Outside MAX the script can
 * still define `window.WebApp`, but calls would go nowhere, so wrappers take their fallback.
 * The launch flag survives client-side navigation, which drops the launch fragment.
 */
export function getMaxBridge(): MaxWebApp | null {
  const bridge = window.WebApp;
  if (!bridge) return null;
  return launchedInMax || Boolean(bridge.initData?.trim()) ? bridge : null;
}

export function waitForMaxBridge(): Promise<MaxContext> {
  const current = initializeMaxBridge();
  if (current.available) return Promise.resolve(current);

  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const context = initializeMaxBridge();
      if (context.available || Date.now() - started >= BRIDGE_WAIT_MS) {
        window.clearInterval(timer);
        resolve(context);
      }
    }, BRIDGE_POLL_MS);
  });
}
