import { useEffect, useRef } from "react";

import { getMaxBridge, type MaxBackButton } from "./bridge";

/*
 * One native MAX «Назад» serves every nested layer (screen → item card → Sheet), so handlers
 * live in a stack (P1-DOC-12 «Нативная кнопка „Назад“»):
 * - a tap calls only the top handler;
 * - the button stays visible while the stack is not empty and hides only when it empties;
 * - the Bridge gets a single listener, so a closing layer never unsubscribes its parent.
 */
const stack: Array<{ handler: () => void }> = [];
let bound: MaxBackButton | null = null;

function dispatch(): void {
  stack[stack.length - 1]?.handler();
}

function sync(): void {
  try {
    const button = getMaxBridge()?.BackButton ?? null;
    if (stack.length > 0) {
      if (button?.onClick && bound !== button) {
        bound?.offClick?.(dispatch);
        button.onClick(dispatch);
        bound = button;
      }
      if (bound) bound.show?.();
      return;
    }
    if (bound) {
      bound.offClick?.(dispatch);
      bound.hide?.();
      bound = null;
    }
  } catch {
    // The Bridge may be missing or already gone while the app closes.
  }
}

/**
 * Puts `handler` on top of the back stack and returns a function that removes exactly this
 * entry (wherever it is — layers may close out of order). Outside MAX it only keeps the stack.
 */
export function pushBackHandler(handler: () => void): () => void {
  const entry = { handler };
  stack.push(entry);
  sync();
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = stack.lastIndexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    sync();
  };
}

/**
 * Shows the native MAX «Назад» while `handler` is set and calls it on tap if this is the
 * topmost layer. Pass null to leave the stack. Outside MAX it does nothing visible: nested
 * screens keep their own close buttons.
 *
 * Order: a layer that becomes active later is on top. Layers mounted in the same commit push
 * child-first (React effect order), so open overlays after their parent screen, not with it.
 */
export function useBackButton(handler: (() => void) | null): void {
  const latest = useRef(handler);
  latest.current = handler;
  const active = handler !== null;

  useEffect(() => {
    if (!active) return;
    return pushBackHandler(() => latest.current?.());
  }, [active]);
}
