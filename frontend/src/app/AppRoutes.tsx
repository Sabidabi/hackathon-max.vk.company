import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { NotFound, Splash } from "../design/screens";
import { parseStartParam, startTargetPath } from "../max/startParam";
import { useIntroDecision } from "./intro";
import { useMaxLaunch } from "./MaxLaunchProvider";
import {
  AdminSurface,
  ConnectSurface,
  GuestSurface,
  HomeSurface,
  IntroSurface,
  InviteSurface,
  LandingSurface,
  NotificationsSurface,
  preloadIntro,
} from "./surfaces";

// Dev-only component showcase. `import.meta.env.DEV` is false in `vite build`,
// so the route and its chunk are dropped from the production bundle.
const UiShowcase = import.meta.env.DEV ? lazy(() => import("../design/Showcase")) : null;

function LaunchRedirect({ to }: { to: string }) {
  const { markLaunchHandled } = useMaxLaunch();
  useEffect(() => markLaunchHandled(), [markLaunchHandled]);
  return <Navigate to={to} replace />;
}

/**
 * `/`: a valid start parameter routes straight to its screen (menu by QR skips Home and the
 * intro); otherwise, inside MAX, the intro on the very first launch and Home
 * afterwards; the product landing in an ordinary browser.
 */
function RootRoute() {
  const { context, resolved, launchHandled } = useMaxLaunch();
  const target = launchHandled ? null : parseStartParam(context.startParam);
  // Navigation runs in a transition, so this route may render once more after the start
  // parameter is handled: it must not flash Home or fetch the intro on the way to the menu.
  const redirected = useRef(false);
  if (target) redirected.current = true;
  const inMax = resolved && context.available && !target && !redirected.current;
  const intro = useIntroDecision(inMax);
  useEffect(() => {
    if (inMax && intro === "pending") preloadIntro();
  }, [inMax, intro]);
  if (target) return <LaunchRedirect to={startTargetPath(target)} />;
  if (!resolved || redirected.current) return <Splash />;
  if (!context.available) return <LandingSurface />;
  if (intro === "pending") return <Splash />;
  return intro === "intro" ? <IntroSurface mode="first" /> : <HomeSurface />;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<Splash />}>
      <Routes>
        <Route path="/" element={<RootRoute />} />
        <Route path="/home" element={<HomeSurface />} />
        <Route path="/intro" element={<IntroSurface mode="replay" />} />
        <Route path="/r/:publicId" element={<GuestSurface />} />
        <Route path="/r/:publicId/i/:itemId" element={<GuestSurface />} />
        <Route path="/manage" element={<AdminSurface />} />
        <Route path="/manage/:publicId/*" element={<AdminSurface />} />
        <Route path="/invite/:token" element={<InviteSurface />} />
        <Route path="/connect" element={<ConnectSurface />} />
        <Route path="/notifications" element={<NotificationsSurface />} />
        {UiShowcase && <Route path="/__ui" element={<UiShowcase />} />}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
