// Dev-only entry for guest menu 2.0 (`/guest-preview.html?path=/r/<id>[/i/<item>]`), used by
// `tests/guest.smoke.cjs` until the router switches `/r/:publicId` to the new menu at merge.
// Loads the same global styles as `main.tsx`, so the preview matches production.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { MaxLaunchProvider } from "../../app/MaxLaunchProvider";
import "../../design/tokens.css";
import "../../design/base.css";
import "../../design/components/components.css";
import "../../styles.css";
import "../../admin.css";
import "../../menu-experience.css";
import GuestMenuSurface from "./GuestMenuSurface";

function PathProbe() {
  const location = useLocation();
  return <output hidden data-testid="preview-path">{location.pathname}</output>;
}

const initialPath = new URLSearchParams(window.location.search).get("path") || "/r/test-point";
const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <MaxLaunchProvider>
          <PathProbe />
          <Routes>
            <Route path="/r/:publicId" element={<GuestMenuSurface />} />
            <Route path="/r/:publicId/i/:itemId" element={<GuestMenuSurface />} />
          </Routes>
        </MaxLaunchProvider>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
