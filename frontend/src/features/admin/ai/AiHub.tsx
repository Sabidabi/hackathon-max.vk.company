import type { CabinetContext } from "../shell/CabinetShell";
import { AiChat } from "./AiChat";
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
