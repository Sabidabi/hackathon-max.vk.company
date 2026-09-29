import { Sparkles } from "lucide-react";
import { useState } from "react";

import { Sheet } from "../../../design";
import { haptics } from "../../../max";
import type { CabinetContext } from "../shell/CabinetShell";
import { AiChat, type AiToolKey } from "./AiChat";
import "./ai-chat.css";

/** The «ИИ» tab of the cabinet: the chat as a page. */
export function AiHub({ context, onOpenSection }: {
  context: CabinetContext;
  onOpenSection: (section: "design" | "menu" | "import") => void;
}) {
  return (
    <div className="ai-page">
      <h1 className="cabinet-title">ИИ-помощник</h1>
      <AiChat point={context.point} onOpenSection={onOpenSection} />
    </div>
  );
}

/** A floating button (bottom left, above the tab bar) that opens the chat over any screen. */
export function AiFab({ context, tool = "edit", onOpenSection }: {
  context: CabinetContext;
  tool?: AiToolKey;
  onOpenSection: (section: "design" | "menu" | "import") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="ai-fab" aria-label="Открыть ИИ-помощника" onClick={() => { haptics.impact("light"); setOpen(true); }}>
        <Sparkles size={22} aria-hidden="true" />
        ИИ
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="ИИ-помощник" wide>
        <div className="ai-sheet">
          <AiChat point={context.point} initialTool={tool} onOpenSection={(section) => { setOpen(false); onOpenSection(section); }} />
        </div>
      </Sheet>
    </>
  );
}
