export type MaxPlatform = "ios" | "android" | "desktop" | "web" | "unknown";

interface MaxWebApp {
  initData?: string;
  platform?: Exclude<MaxPlatform, "unknown">;
  version?: string;
  ready?: () => void;
  expand?: () => void;
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

function readLaunchFragment(): { initData: string; platform: MaxPlatform; version: string | null } {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  // A duplicated outer parameter is ambiguous; the backend separately checks
  // duplicate fields inside signed WebAppData before creating a session.
  if (fragment.getAll("WebAppData").length !== 1) {
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
  if (!initData) {
    return { available: false, initData: "", platform: "unknown", version: null, startParam: null };
  }
  const startParam = new URLSearchParams(initData).get("start_param");
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
    bridge.ready?.();
    bridge.expand?.();
  } catch {
    // Display methods are optional; signed login still proceeds on the server.
  }
}

export function initializeMaxBridge(): MaxContext {
  const context = readMaxContext();
  if (context.available) prepareBridge();
  return context;
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
