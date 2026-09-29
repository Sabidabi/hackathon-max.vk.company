import { Bird, RotateCcw, SendHorizontal, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { Chip, Skeleton } from "../../design";
import { haptics } from "../../max";
import { askSinitsa, formatMoney, GuestApiError, type AskAnswer, type AskPick, type GuestAssistant } from "./api";
import { MotionSheet } from "./MotionSheet";
import { trackGuestEvent } from "./session";

/** Ready-made wishes: one tap asks. */
export const ASK_CHIPS = ["Без кофеина", "Сладкое", "Что-то тёплое"] as const;

type AskState =
  | { kind: "idle" }
  | { kind: "loading"; question: string }
  | { kind: "answer"; question: string; answer: AskAnswer }
  | { kind: "error"; question: string; message: string };

/** Entry point in the menu: a quiet pill under the search, in the venue theme. */
export function AskButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="g-ask-entry" onClick={onOpen}>
      <span className="g-ask-entry__bird" aria-hidden="true"><Bird size={18} /></span>
      <span>Синица, что взять?</span>
    </button>
  );
}

/**
 * «Синица, что взять?»: the guest writes a wish (or taps a chip), the server answers with up
 * to three available positions of this point's menu. Without AI the same sheet shows picks
 * without it — the guest never hits a dead end. Cards open the position's own sheet.
 */
export function AskSheet({ open, onClose, publicId, assistant, onPick }: {
  open: boolean;
  onClose: () => void;
  publicId: string;
  assistant: GuestAssistant;
  onPick: (pick: AskPick) => void;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<AskState>({ kind: "idle" });
  const request = useRef<AbortController | null>(null);
  const aiOn = assistant.available;

  useEffect(() => () => request.current?.abort(), []);

  const ask = useCallback((question: string, via: "chip" | "text") => {
    const clean = question.trim();
    if (!clean) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    haptics.selection();
    // Analytics never gets the guest's words: only how they asked.
    trackGuestEvent("ai_ask", { public_id: publicId, via, ai: aiOn });
    setState({ kind: "loading", question: clean });
    askSinitsa(publicId, clean, controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        setState({ kind: "answer", question: clean, answer });
        if (answer.items.length) haptics.notify("success");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof GuestApiError ? error.message : "Не удалось получить подсказку";
        setState({ kind: "error", question: clean, message });
      });
  }, [aiOn, publicId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    ask(text, "text");
  };

  const answer = state.kind === "answer" ? state.answer : null;
  const demo = assistant.provider === "mock" || answer?.provider === "mock";

  return (
    <MotionSheet
      open={open}
      onClose={onClose}
      title={
        <span className="g-ask-title">
          Синица, что взять?
          {aiOn && demo && <span className="g-ask-demo" data-testid="ask-demo">Демо-ИИ</span>}
        </span>
      }
    >
      <div className="g-ask">
        {aiOn ? (
          <form className="g-ask-form" onSubmit={submit}>
            <label className="g-search__field g-ask-form__field">
              <Sparkles size={18} aria-hidden="true" />
              <input
                value={text}
                maxLength={300}
                placeholder="Например, сладкое без кофеина"
                aria-label="Что вам хочется?"
                enterKeyHint="send"
                onChange={(event) => setText(event.target.value)}
              />
              <button type="submit" className="g-search__clear g-ask-form__send" aria-label="Спросить" disabled={!text.trim() || state.kind === "loading"}>
                <SendHorizontal size={18} aria-hidden="true" />
              </button>
            </label>
          </form>
        ) : (
          <p className="g-ask-off" role="status">ИИ сейчас недоступен. Выберите пожелание — подберём по меню.</p>
        )}

        <div className="g-ask-chips" role="group" aria-label="Быстрые пожелания">
          {ASK_CHIPS.map((chip) => (
            <Chip
              key={chip}
              selected={state.kind !== "idle" && state.question === chip}
              onClick={() => {
                setText(aiOn ? chip : "");
                ask(chip, "chip");
              }}
            >
              {chip}
            </Chip>
          ))}
        </div>

        <div className="g-ask-result" aria-live="polite" aria-busy={state.kind === "loading"}>
          {state.kind === "idle" && (
            <p className="g-ask-hint">Напишите, чего хочется, — предложим до трёх позиций из меню.</p>
          )}
          {state.kind === "loading" && (
            <div className="g-ask-list" aria-label="Подбираем">
              {[0, 1, 2].map((index) => <Skeleton key={index} height={64} radius="card" className="g-ask-skeleton" />)}
            </div>
          )}
          {state.kind === "error" && (
            <div className="g-ask-error" role="alert">
              <p>{state.message}</p>
              <button type="button" className="g-ask-retry" onClick={() => ask(state.question, "text")}>
                <RotateCcw size={16} aria-hidden="true" />Попробовать снова
              </button>
            </div>
          )}
          {answer && (
            <>
              {answer.source === "ai" && answer.reason && (
                <div className="g-ask-reason">
                  <span className="g-ask-entry__bird" aria-hidden="true"><Bird size={16} /></span>
                  <p>{answer.reason}</p>
                </div>
              )}
              {answer.notice && (aiOn || answer.limited) && <p className="g-ask-notice" data-testid="ask-notice">{answer.notice}</p>}
              {answer.items.length ? (
                <ul className="g-ask-list" aria-label="Синица советует">
                  {answer.items.map((pick, index) => (
                    <li key={pick.id} style={{ "--g-ask-index": index } as CSSProperties}>
                      <button
                        type="button"
                        className="g-ask-card"
                        aria-label={`Открыть ${pick.name}`}
                        onClick={() => {
                          trackGuestEvent("ai_answer_click", { public_id: publicId, position: index + 1, source: answer.source });
                          onPick(pick);
                        }}
                      >
                        {pick.image_url && <img src={pick.image_url} alt="" width={56} height={56} loading="lazy" />}
                        <span className="g-ask-card__text">
                          <span className="g-ask-card__name">{pick.name}</span>
                          <span className="g-ask-card__section">{pick.section}</span>
                        </span>
                        <span className="g-ask-card__price">{pick.has_sizes ? "от " : ""}{formatMoney(pick.price_minor)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="g-ask-hint">Ничего подходящего не нашли. Попробуйте сказать иначе.</p>
              )}
            </>
          )}
        </div>
      </div>
    </MotionSheet>
  );
}
