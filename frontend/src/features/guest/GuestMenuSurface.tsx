import { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useMaxLaunch } from "../../app/MaxLaunchProvider";
import { GuestSurface } from "./GuestMenu";

/**
 * Route entry of guest menu 2.0 for `/r/:publicId` and `/r/:publicId/i/:itemId`.
 * The router loads it through `GuestSurface.tsx`, which re-exports it (P1-TASK-59).
 */
export default function GuestMenuSurface() {
  const { publicId = "", itemId = null } = useParams();
  const { context } = useMaxLaunch();
  const navigate = useNavigate();
  const closeLinkedItem = useCallback(
    () => navigate(`/r/${encodeURIComponent(publicId)}`, { replace: true }),
    [navigate, publicId],
  );
  return (
    <GuestSurface
      key={publicId}
      publicId={publicId}
      itemId={itemId}
      maxContext={context}
      onLinkedItemClose={itemId ? closeLinkedItem : undefined}
    />
  );
}
