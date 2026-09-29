import { useParams } from "react-router-dom";

import { AccountShell } from "../auth/AccountShell";
import { CabinetShell } from "./shell/CabinetShell";

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * `/manage` and `/manage/:publicId/{menu,analytics,design,more/...}` — the venue cabinet.
 * The URL only selects a point and a section; membership and role are checked by the server
 * on every cabinet request. Outside MAX a signed-out visitor gets «Откройте в MAX» with
 * `startapp=manage_<id>`.
 */
export default function AdminSurface() {
  const { publicId = null, "*": rest = "" } = useParams();
  const startPayload = publicId && PUBLIC_ID.test(publicId) ? `manage_${publicId}` : null;
  return (
    <AccountShell startPayload={startPayload} frame="bare">
      <CabinetShell publicId={publicId} path={rest} />
    </AccountShell>
  );
}
