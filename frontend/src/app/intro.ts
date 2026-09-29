import { useEffect, useSyncExternalStore } from "react";

import { deviceStorage } from "../max/platform";

/*
 * «Показать интро один раз». The flag lives in MAX
 * DeviceStorage with a localStorage fallback; it stores no personal data. The decision is
 * taken once per launch and kept in memory: once the intro is on screen it stays until the
 * user leaves it, even though the flag is written as soon as it appears.
 */
export const INTRO_STORAGE_KEY = "sinitsa.intro.v1";
/** DeviceStorage may never answer on an old client: then the local copy decides. */
const STORAGE_WAIT_MS = 1_200;

export type IntroDecision = "pending" | "intro" | "home";

let decision: IntroDecision = "pending";
let loading = false;
const listeners = new Set<() => void>();

function setDecision(next: IntroDecision): void {
  if (decision === next) return;
  decision = next;
  listeners.forEach((listener) => listener());
}

function localSeen(): boolean {
  try {
    return Boolean(window.localStorage.getItem(INTRO_STORAGE_KEY));
  } catch {
    return false;
  }
}

async function loadDecision(): Promise<void> {
  if (loading || decision !== "pending") return;
  loading = true;
  const stored = await Promise.race([
    deviceStorage.getItem(INTRO_STORAGE_KEY),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), STORAGE_WAIT_MS)),
  ]);
  setDecision(stored || localSeen() ? "home" : "intro");
}

/** Writes the flag to DeviceStorage and the local copy. Never throws. */
export function rememberIntroSeen(): void {
  void deviceStorage.setItem(INTRO_STORAGE_KEY, "1");
  try {
    window.localStorage.setItem(INTRO_STORAGE_KEY, "1");
  } catch {
    // Blocked storage: DeviceStorage (inside MAX) still remembers.
  }
}

/** The user left the first-launch intro: `/` shows Home from now on. */
export function finishIntro(): void {
  rememberIntroSeen();
  setDecision("home");
}

/**
 * Whether `/` shows the intro or Home. `enabled` is true only inside MAX without a start
 * parameter; while the flag is read the answer is `pending` (the caller keeps the splash).
 */
export function useIntroDecision(enabled: boolean): IntroDecision {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => decision,
  );
  useEffect(() => {
    if (enabled) void loadDecision();
  }, [enabled]);
  return value;
}
