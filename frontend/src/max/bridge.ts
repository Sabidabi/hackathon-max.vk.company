export type MaxPlatform = "ios" | "android" | "desktop" | "web" | "unknown";

interface MaxWebApp {
  initData?: string;
  platform?: Exclude<MaxPlatform, "unknown">;
  version?: string;
  ready?: () => void;
  expand?: () => void;
  initDataUnsafe?: {
    start_param?: string;
  };
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

export function initializeMaxBridge(): MaxContext {
  const bridge = window.WebApp;
  const initData = bridge?.initData?.trim() ?? "";

  // Some embedded browsers expose a generic window.WebApp object. A real MAX
  // mini-app launch is identified by the signed initData payload, not by the
  // global object alone.
  if (!bridge || !initData) {
    return {
      available: false,
      initData: "",
      platform: "unknown",
      version: null,
      startParam: null,
    };
  }

  bridge.ready?.();
  bridge.expand?.();

  return {
    available: true,
    initData,
    platform: bridge.platform ?? "unknown",
    version: bridge.version ?? null,
    startParam: bridge.initDataUnsafe?.start_param ?? null,
  };
}
