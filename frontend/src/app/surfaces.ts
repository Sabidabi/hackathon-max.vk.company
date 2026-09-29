import { lazy } from "react";

// Each product surface is its own production chunk (P1-DOC-13 «Раздельные чанки»):
// a guest opening `/r/:id` never downloads the cabinet, the landing never downloads the menu.
// The file names become chunk names; `tests/demo.smoke.cjs` relies on `AdminSurface`.
export const LandingSurface = lazy(() => import("../features/landing/LandingSurface"));
export const HomeSurface = lazy(() => import("../features/home/HomeSurface"));
export const GuestSurface = lazy(() => import("../features/guest/GuestSurface"));
export const AdminSurface = lazy(() => import("../features/admin/AdminSurface"));
export const ConnectSurface = lazy(() => import("../features/home/ConnectSurface"));
export const InviteSurface = lazy(() => import("../features/auth/InviteSurface"));
export const NotificationsSurface = lazy(() =>
  import("../features/notifications/NotificationsSurface").then((module) => ({ default: module.NotificationsSurface })),
);
// First-launch intro inside MAX (P1-TASK-62): its own chunk, never loaded by a guest who
// arrives by QR (`startapp=r_*` routes before the intro is considered).
const loadIntro = () => import("../features/intro/IntroSurface");
export const IntroSurface = lazy(loadIntro);
/** Warms the intro chunk while the DeviceStorage flag is read. */
export function preloadIntro(): void {
  void loadIntro().catch(() => undefined);
}
