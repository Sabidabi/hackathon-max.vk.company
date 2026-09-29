import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { initializeMaxBridge, waitForMaxBridge, type MaxContext } from "../max/bridge";
import { ready } from "../max/platform";

interface MaxLaunchState {
  /** Launch data captured once per app start; survives client-side navigation. */
  context: MaxContext;
  /** True once MAX is detected or the bridge wait has timed out. */
  resolved: boolean;
  /** The start parameter has already routed the user; `/` shows Home/landing afterwards. */
  launchHandled: boolean;
  markLaunchHandled: () => void;
}

const MaxLaunchContext = createContext<MaxLaunchState | null>(null);

export function MaxLaunchProvider({ children }: { children: ReactNode }) {
  const [launch, setLaunch] = useState(() => {
    const context = initializeMaxBridge();
    return { context, resolved: context.available };
  });
  const [launchHandled, setLaunchHandled] = useState(false);

  useEffect(() => {
    if (launch.resolved) return;
    let active = true;
    void waitForMaxBridge().then((next) => {
      if (!active) return;
      // Client-side navigation drops `?WebAppStartParam` and the launch fragment,
      // so keep the first start parameter we saw.
      setLaunch((current) => ({
        context: { ...next, startParam: next.startParam ?? current.context.startParam },
        resolved: true,
      }));
    });
    return () => {
      active = false;
    };
  }, [launch.resolved]);

  // P1-DOC-12 «Сигнал готовности»: after the first commit (launch screen, skeleton or
  // surface) tell MAX to drop its splash. Idempotent; a no-op outside MAX.
  useEffect(() => {
    if (launch.context.available) ready();
  }, [launch.context.available]);

  const markLaunchHandled = useCallback(() => setLaunchHandled(true), []);
  const value = useMemo(
    () => ({ context: launch.context, resolved: launch.resolved, launchHandled, markLaunchHandled }),
    [launch, launchHandled, markLaunchHandled],
  );
  return <MaxLaunchContext.Provider value={value}>{children}</MaxLaunchContext.Provider>;
}

export function useMaxLaunch(): MaxLaunchState {
  const value = useContext(MaxLaunchContext);
  if (!value) throw new Error("useMaxLaunch must be used inside MaxLaunchProvider");
  return value;
}
