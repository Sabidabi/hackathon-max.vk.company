import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  FileText,
  Paperclip,
  Palette,
  ScanText,
  ShieldCheck,
  Sparkles,
  Square,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { checkMenu, type MenuCheck } from "../../../api/ai";
import type { AuthUser } from "../../../api/auth";
import { fetchImportReview, listImports, uploadMenuSource, type ImportJob } from "../../../api/imports";
import { applyMenuChange, planMenuChange, type MenuAiProposal } from "../../../api/menuAi";
import type { Restaurant } from "../../../api/restaurants";
import { applyDesign, describeChange, planDesign, type DesignProposal } from "../../../api/siteAi";
import { fetchSiteDraft } from "../../../api/site";
import { fetchLibraryDraft, venueKeys } from "../../../api/venues";
import { Button } from "../../../design";
import { haptics } from "../../../max";
import "./ai-chat.css";

export type AiToolKey = "design" | "fill" | "edit" | "check";

interface Tool {
  key: AiToolKey;
  title: string;
  accessibleLabel: string;
  hint: string;
  icon: LucideIcon;
  placeholder: string;
  examples: string[];
  /** Runs at once, without text. */
  instant?: boolean;
}

const TOOLS: Tool[] = [
  {
    key: "design",
    title: "Стиль",
    accessibleLabel: "Оформление",
    hint: "Цвета и шрифты",
    icon: Palette,
    placeholder: "Что изменить в оформлении?",
    examples: ["Тёмная тема, плитки списком", "Шрифт с засечками и круглые углы", "Кнопка «Добавить» с подписью"],
  },
  {
    key: "fill",
    title: "Из файла",
    accessibleLabel: "Из фото или PDF",
    hint: "Фото или PDF",
    icon: ScanText,
    placeholder: "Прикрепите фото или PDF меню",
    examples: [],
  },
  {
    key: "edit",
    title: "Добавить",
    accessibleLabel: "Поправить меню",
    hint: "Позиции меню",
    icon: WandSparkles,
    placeholder: "Что добавить или поправить в меню?",
    examples: [
      "Добавь капучино: 300 мл за 190 ₽ и 400 мл за 230 ₽",
      "Латте с обязательным выбором молока: овсяное +50 ₽",
    ],
  },
  {
    key: "check",
    title: "Проверка",
    accessibleLabel: "Проверить меню",
    hint: "Цены и дубли",
    icon: ShieldCheck,
    placeholder: "",
    examples: [],
    instant: true,
  },
];

type Decision = "pending" | "applying" | "applied" | "dismissed";

type Message =
  | { id: number; role: "user"; text: string; files: string[] }
  | { id: number; role: "assistant"; kind: "text"; text: string; tone?: "error" | "info" }
  | { id: number; role: "assistant"; kind: "design"; proposal: DesignProposal; revision: string; state: Decision }
  | { id: number; role: "assistant"; kind: "menu"; proposal: MenuAiProposal; revision: string; state: Decision }
  | { id: number; role: "assistant"; kind: "check"; check: MenuCheck }
  | { id: number; role: "assistant"; kind: "import"; job: ImportJob; items: number | null };

const rubles = (value: number) =>
  new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: value % 100 === 0 ? 0 : 2 }).format(value / 100);

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
});

const FINISHED = new Set(["needs_review", "completed", "failed"]);

/**
 * The AI chat of the cabinet: pick a tool (design, fill from a photo or PDF, fix the menu,
 * check the menu), attach files, write in plain words. The AI only proposes: every result is a
 * card that a person applies to the draft, and nothing is published from here. Text from the
 * model is drawn as plain text; a request can be stopped at any moment.
 */
export function AiChat({ point, initialTool = "edit", onOpenSection }: {
  point: Restaurant;
  initialTool?: AiToolKey;
  /** Where a result lives: the cabinet section the card links to. */
  onOpenSection?: (section: "design" | "menu" | "import") => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const userId = queryClient.getQueryData<AuthUser>(["current-user"])?.id ?? "unknown";
  const historyKey = ["ai-chat-history", userId, point.id] as const;
  const draftKey = ["ai-chat-draft", userId, point.id] as const;
  const [tool, setTool] = useState<AiToolKey>(() => queryClient.getQueryData<AiToolKey>([...draftKey, "tool"]) ?? initialTool);
  const [messages, setMessages] = useState<Message[]>(() => queryClient.getQueryData<Message[]>(historyKey) ?? []);
  const [text, setText] = useState(() => queryClient.getQueryData<string>(draftKey) ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(Math.max(0, ...messages.map((message) => message.id)) + 1);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const current = TOOLS.find((item) => item.key === tool) ?? TOOLS[0];

  useEffect(() => { queryClient.setQueryData(historyKey, messages); }, [messages, point.id, queryClient, userId]);
  useEffect(() => { queryClient.setQueryData(draftKey, text); }, [text, point.id, queryClient, userId]);
  useEffect(() => { queryClient.setQueryData([...draftKey, "tool"], tool); }, [tool, point.id, queryClient, userId]);
  useEffect(() => () => {
    if (abort.current) {
      abort.current.abort();
      queryClient.setQueryData<Message[]>(historyKey, (list = []) => [
        ...list,
        { id: nextId.current++, role: "assistant", kind: "text", text: "Запрос прервался при смене точки. Отправьте его ещё раз.", tone: "info" },
      ]);
    }
  }, [point.id, queryClient, userId]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const push = useCallback((message: Omit<Message, "id"> | Message) => {
    const id = nextId.current++;
    setMessages((list) => [...list, { ...message, id } as Message]);
    return id;
  }, []);
  const patch = useCallback((id: number, update: Partial<Message>) => {
    setMessages((list) => list.map((message) => (message.id === id ? ({ ...message, ...update } as Message) : message)));
  }, []);
  const say = useCallback((textValue: string, tone?: "error" | "info") => push({ role: "assistant", kind: "text", text: textValue, tone }), [push]);

  async function run(label: string, job: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(label);
    try {
      await job(controller.signal);
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) say("Остановила. Ничего не изменилось.", "info");
      else say(error instanceof Error ? error.message : "Не получилось. Попробуйте ещё раз.", "error");
      haptics.notify("error");
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(null);
    }
  }

  const stop = () => abort.current?.abort();

  async function runCheck() {
    if (!point.menu_id) {
      say("Сначала создайте меню: проверять пока нечего.", "info");
      return;
    }
    push({ role: "user", text: "Проверь меню", files: [] });
    await run("Проверяю меню…", async (signal) => {
      const check = await checkMenu(point.menu_id!, signal);
      push({ role: "assistant", kind: "check", check });
      haptics.notify("success");
    });
  }

  function chooseTool(key: AiToolKey) {
    haptics.selection();
    setTool(key);
    if (key === "check" && !busy) void runCheck();
    if (key === "fill" && !files.length) fileInput.current?.click();
  }

  async function send() {
    const request = text.trim();
    if (busy) return;
    if (files.length || tool === "fill") {
      if (!files.length) {
        say("Прикрепите фото или PDF меню кнопкой со скрепкой.", "info");
        return;
      }
      await sendFiles(request);
      return;
    }
    if (tool === "check") {
      await runCheck();
      return;
    }
    if (request.length < 3) return;
    setText("");
    push({ role: "user", text: request, files: [] });
    if (tool === "design") {
      await run("Подбираю оформление…", async (signal) => {
        const draft = await fetchSiteDraft(point.id);
        const proposal = await planDesign(point.id, request, draft.revision, signal);
        push({ role: "assistant", kind: "design", proposal, revision: draft.revision, state: "pending" });
        haptics.notify("success");
      });
      return;
    }
    if (!point.menu_id) {
      say("Сначала создайте меню, потом я помогу его поправить.", "info");
      return;
    }
    await run("Готовлю изменения меню…", async (signal) => {
      const draft = await fetchLibraryDraft(point.menu_id!);
      const proposal = await planMenuChange(point.id, request, draft.revision, signal);
      push({ role: "assistant", kind: "menu", proposal, revision: draft.revision, state: "pending" });
      haptics.notify("success");
    });
  }

  async function sendFiles(request: string) {
    const selected = files;
    setFiles([]);
    setText("");
    setTool("fill");
    push({ role: "user", text: request, files: selected.map((file) => file.name) });
    await run("Загружаю файлы…", async (signal) => {
      for (const file of selected) {
        const job = await uploadMenuSource(point.id, file);
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        let latest: ImportJob = job;
        const started = Date.now();
        setBusy(`Распознаю «${file.name}»…`);
        while (!FINISHED.has(latest.status) && Date.now() - started < 120_000) {
          await sleep(2_000, signal);
          latest = (await listImports(point.id)).find((entry) => entry.id === job.id) ?? latest;
        }
        let items: number | null = latest.item_count;
        if (latest.status === "needs_review" && items === null) {
          items = (await fetchImportReview(point.id, job.id)).sections.reduce((sum, section) => sum + section.items.length, 0);
        }
        push({ role: "assistant", kind: "import", job: latest, items });
      }
      haptics.notify("success");
    });
  }

  async function decide(id: number, kind: "design" | "menu", proposalId: string, revision: string) {
    patch(id, { state: "applying" } as Partial<Message>);
    await run("Применяю в черновик…", async (signal) => {
      try {
        if (kind === "design") {
          const draft = await applyDesign(point.id, proposalId, revision, signal);
          queryClient.setQueryData(["site-draft", point.id], draft);
          say("Готово: оформление изменено в черновике. Гости увидят его после публикации в разделе «Оформление».");
        } else {
          const draft = await applyMenuChange(point.id, proposalId, revision, signal);
          queryClient.setQueryData(venueKeys.draft(point.menu_id ?? "none"), draft);
          await queryClient.invalidateQueries({ queryKey: ["venue-menus"] });
          say("Готово: позиции добавлены в черновик меню. Опубликуйте меню, когда проверите.");
        }
        patch(id, { state: "applied" } as Partial<Message>);
        haptics.notify("success");
      } catch (error) {
        patch(id, { state: "pending" } as Partial<Message>);
        throw error;
      }
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function attach(list: FileList | null) {
    if (!list?.length) return;
    setFiles((current) => [...current, ...Array.from(list)].slice(0, 6));
    setTool("fill");
  }

  const canSend = !busy && (files.length > 0 || (tool !== "check" && tool !== "fill" && text.trim().length >= 3) || tool === "check");

  return (
    <section className="ai-chat" aria-label="Помощь Синицы">
      <div className="ai-chat__tools" role="radiogroup" aria-label="Что сделать">
        {TOOLS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              role="radio"
              aria-label={item.accessibleLabel}
              aria-checked={tool === item.key}
              className="ai-tool"
              disabled={Boolean(busy)}
              onClick={() => chooseTool(item.key)}
            >
              <span className="ai-tool__icon" aria-hidden="true"><Icon size={20} /></span>
              <span className="ai-tool__text"><strong>{item.title}</strong><small>{item.hint}</small></span>
            </button>
          );
        })}
      </div>

      <div className="ai-chat__list" ref={listRef} role="log" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 && (
          <div className="ai-empty">
            <span className="ai-empty__icon" aria-hidden="true"><Sparkles size={26} /></span>
            <h2>Чем помочь?</h2>
            <p>Выберите, что сделать, и напишите обычными словами. ИИ предложит правки, а применяете их вы.</p>
            {current.examples.length > 0 && (
              <div className="ai-examples">
                {current.examples.map((example) => (
                  <button key={example} type="button" className="ai-example" onClick={() => setText(example)}>{example}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            onDecide={decide}
            onDismiss={(id) => patch(id, { state: "dismissed" } as Partial<Message>)}
            onOpen={(section) => {
              if (section === "import") navigate(`/manage/${point.public_id}/more/import`);
              else if (onOpenSection) onOpenSection(section);
              else navigate(`/manage/${point.public_id}/${section}`);
            }}
          />
        ))}
        {busy && (
          <div className="ai-msg ai-msg--assistant" role="status">
            <div className="ai-bubble ai-bubble--typing"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>{busy}</div>
          </div>
        )}
      </div>

      <div className="ai-composer">
        {files.length > 0 && (
          <ul className="ai-files" aria-label="Вложения">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`}>
                <FileText size={16} aria-hidden="true" />
                <span>{file.name}</span>
                <button type="button" aria-label={`Убрать ${file.name}`} onClick={() => setFiles((list) => list.filter((_, at) => at !== index))}><X size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="ai-composer__row">
          <input ref={fileInput} type="file" hidden multiple accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf" onChange={(event) => { attach(event.target.files); event.target.value = ""; }} />
          <button type="button" className="ai-composer__attach" aria-label="Прикрепить фото или PDF" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
            <Paperclip size={22} />
          </button>
          <textarea
            className="ai-composer__input"
            rows={1}
            maxLength={800}
            value={text}
            placeholder={files.length ? "Подпись к файлам (необязательно)" : current.placeholder || "Нажмите стрелку, чтобы проверить меню"}
            aria-label="Сообщение для ИИ"
            disabled={Boolean(busy) || tool === "check"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button type="button" className="ai-composer__send ai-composer__send--stop" aria-label="Остановить" onClick={stop}><Square size={18} fill="currentColor" /></button>
          ) : (
            <button type="button" className="ai-composer__send" aria-label={tool === "check" ? "Проверить меню" : "Отправить"} disabled={!canSend} onClick={() => void send()}><ArrowUp size={22} strokeWidth={2.5} /></button>
          )}
        </div>
      </div>
    </section>
  );
}

function StateFooter({ state, onApply, onDismiss, applyLabel }: { state: Decision; onApply: () => void; onDismiss: () => void; applyLabel: string }): ReactNode {
  if (state === "applied") return <p className="ai-card__done"><Check size={16} aria-hidden="true" /> Применено в черновик</p>;
  if (state === "dismissed") return <p className="ai-card__done ai-card__done--muted">Отклонено</p>;
  return (
    <div className="ai-card__actions">
      <Button variant="secondary" disabled={state === "applying"} onClick={onDismiss}>Отклонить</Button>
      <Button loading={state === "applying"} icon={<Check size={18} />} onClick={onApply}>{applyLabel}</Button>
    </div>
  );
}

function MessageView({ message, onDecide, onDismiss, onOpen }: {
  message: Message;
  onDecide: (id: number, kind: "design" | "menu", proposalId: string, revision: string) => void;
  onDismiss: (id: number) => void;
  onOpen: (section: "design" | "menu" | "import") => void;
}) {
  if (message.role === "user") {
    return (
      <div className="ai-msg ai-msg--user">
        <div className="ai-bubble ai-bubble--user">
          {message.files.length > 0 && <ul className="ai-bubble__files">{message.files.map((name) => <li key={name}><FileText size={14} aria-hidden="true" />{name}</li>)}</ul>}
          {message.text && <p>{message.text}</p>}
        </div>
      </div>
    );
  }
  if (message.kind === "text") {
    return (
      <div className="ai-msg ai-msg--assistant">
        <div className={`ai-bubble${message.tone === "error" ? " ai-bubble--error" : ""}`}>
          {message.tone === "error" && <AlertTriangle size={16} aria-hidden="true" />}
          <p>{message.text}</p>
        </div>
      </div>
    );
  }
  if (message.kind === "design") {
    const changes = Object.entries(message.proposal.changes).map(([key, value]) => describeChange(key, value));
    return (
      <div className="ai-msg ai-msg--assistant">
        <article className="ai-card">
          <header className="ai-card__head">
            <strong>{message.proposal.summary}</strong>
            {message.proposal.provider === "mock" && <span className="ai-badge">Демо-ИИ</span>}
          </header>
          <ul className="ai-changes">
            {changes.map((change) => (
              <li key={change.label}>
                <span>{change.label}</span>
                <b>{change.color && <i className="ai-swatch" style={{ background: change.color }} aria-hidden="true" />}{change.text}</b>
              </li>
            ))}
          </ul>
          {message.proposal.warnings.map((warning) => <p key={warning} className="ai-card__warn"><AlertTriangle size={14} aria-hidden="true" />{warning}</p>)}
          <StateFooter state={message.state} applyLabel="Применить в черновик" onApply={() => onDecide(message.id, "design", message.proposal.proposal_id, message.revision)} onDismiss={() => onDismiss(message.id)} />
          {message.state === "applied" && <Button variant="ghost" onClick={() => onOpen("design")}>Открыть «Оформление»</Button>}
        </article>
      </div>
    );
  }
  if (message.kind === "menu") {
    return (
      <div className="ai-msg ai-msg--assistant">
        <article className="ai-card">
          <header className="ai-card__head"><strong>{message.proposal.plan.summary}</strong></header>
          {message.proposal.plan.warnings.map((warning) => <p key={warning} className="ai-card__warn"><AlertTriangle size={14} aria-hidden="true" />{warning}</p>)}
          <ul className="ai-plan-items">
            {message.proposal.plan.operations.map((operation, index) => (
              <li key={`${operation.section_name}-${operation.item.name}-${index}`}>
                <small>{operation.section_name}</small>
                <strong>{operation.item.name}</strong>
                <span>{rubles(operation.item.base_price_minor)}</span>
                {operation.item.variants.length > 0 && <p>{operation.item.variants.map((variant) => `${variant.name} · ${rubles(variant.price_minor)}`).join("  /  ")}</p>}
                {operation.item.modifier_groups.map((group) => <p key={group.name}>{group.name}{group.min_quantity > 0 ? " · обязательно" : ""}: {group.options.map((option) => option.name).join(", ")}</p>)}
              </li>
            ))}
          </ul>
          <StateFooter state={message.state} applyLabel="Добавить в черновик" onApply={() => onDecide(message.id, "menu", message.proposal.proposal_id, message.revision)} onDismiss={() => onDismiss(message.id)} />
          {message.state === "applied" && <Button variant="ghost" onClick={() => onOpen("menu")}>Открыть меню</Button>}
        </article>
      </div>
    );
  }
  if (message.kind === "check") {
    const { check } = message;
    return (
      <div className="ai-msg ai-msg--assistant">
        <article className="ai-card">
          <header className="ai-card__head">
            <strong>{check.findings.length ? `Нашла замечаний: ${check.findings.length}` : "Замечаний нет"}</strong>
            {check.provider === "mock" && <span className="ai-badge">Демо-ИИ</span>}
          </header>
          {check.summary && <p className="ai-card__text">{check.summary}</p>}
          {check.findings.length > 0 && (
            <ul className="ai-findings">
              {check.findings.slice(0, 12).map((finding, index) => (
                <li key={`${finding.code}-${finding.item_key ?? index}`} className={finding.severity === "warning" ? "ai-finding--warn" : undefined}>
                  <span>{finding.message}</span>
                  {finding.tip && <small>{finding.tip}</small>}
                </li>
              ))}
            </ul>
          )}
          {check.findings.length > 12 && <p className="ai-card__text">И ещё {check.findings.length - 12}.</p>}
          {check.findings.length > 0 && <Button variant="ghost" onClick={() => onOpen("menu")}>Исправить в меню</Button>}
        </article>
      </div>
    );
  }
  const failed = message.job.status === "failed";
  return (
    <div className="ai-msg ai-msg--assistant">
      <article className="ai-card">
        <header className="ai-card__head"><strong>{failed ? "Не удалось разобрать файл" : "Файл разобран"}</strong></header>
        <p className="ai-card__text">
          {failed
            ? message.job.error_message ?? "Попробуйте фото получше или PDF с текстом."
            : message.items !== null
              ? `Нашла позиций: ${message.items}. Проверьте названия и цены и добавьте их в меню.`
              : "Результат готов к проверке."}
        </p>
        {!failed && <Button icon={<Check size={18} />} onClick={() => onOpen("import")}>Проверить и добавить</Button>}
      </article>
    </div>
  );
}
