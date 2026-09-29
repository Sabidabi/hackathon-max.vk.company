import { useQuery } from "@tanstack/react-query";
import { BarChart3, CircleAlert, Eye, FlaskConical, QrCode, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { Button, Chip, EmptyState, Skeleton } from "../../../design";
import type { CabinetContext } from "../shell/CabinetShell";
import "./analytics.css";

type Period = "today" | "7d" | "30d";

interface ItemStat { item_key: string; name: string; views: number; adds: number }
export interface AnalyticsReport {
  period: Period;
  has_data: boolean;
  synthetic: boolean;
  demo_venue: boolean;
  guests: { max_users: number; web_sessions: number };
  choices: number;
  choice_rate: number | null;
  avg_choice_size: number | null;
  funnel: { step: string; sessions: number; rate: number | null }[];
  daily: { day: string; sessions: number }[];
  top_viewed: ItemStat[];
  top_chosen: ItemStat[];
  looked_not_chosen: ItemStat[];
  empty_searches: { query: string; hits: number }[];
  recommendations: { impressions: number; clicks: number; adds: number };
  d7_return: { base: number; returned: number; rate: number | null };
}

async function fetchAnalytics(venueId: string, period: Period, point: string | null): Promise<AnalyticsReport> {
  const params = new URLSearchParams({ period });
  if (point) params.set("point", point);
  const response = await fetch(`/api/v1/venues/${encodeURIComponent(venueId)}/analytics?${params}`, { credentials: "include" });
  if (!response.ok) throw new Error(response.status === 404 ? "Нет доступа к аналитике" : "Не удалось загрузить аналитику");
  return (await response.json()) as AnalyticsReport;
}

export type SummaryState = "ok" | "few_data" | "ai_unavailable" | "ai_limit";
export interface AiSummary { state: SummaryState; text: string; tips: string[]; guests: number | null }

/** Weekly AI summary: any malformed or failed answer just hides the block. */
async function fetchAiSummary(venueId: string, point: string | null): Promise<AiSummary> {
  const params = new URLSearchParams();
  if (point) params.set("point", point);
  const response = await fetch(`/api/v1/venues/${encodeURIComponent(venueId)}/analytics/ai-summary?${params}`, { credentials: "include" });
  if (!response.ok) throw new Error("summary");
  const raw = (await response.json()) as Partial<{ state: string; text: string | null; tips: unknown; metrics: { guests?: unknown } }>;
  const state: SummaryState = raw.state === "ok" || raw.state === "few_data" || raw.state === "ai_limit" ? raw.state : "ai_unavailable";
  return {
    state,
    text: typeof raw.text === "string" ? raw.text : "",
    tips: Array.isArray(raw.tips) ? raw.tips.filter((tip): tip is string => typeof tip === "string").slice(0, 3) : [],
    guests: typeof raw.metrics?.guests === "number" ? raw.metrics.guests : null,
  };
}

const SUMMARY_NOTE: Record<Exclude<SummaryState, "ok">, string> = {
  few_data: "Сводка появится, когда наберётся данных",
  ai_unavailable: "ИИ сейчас недоступен",
  ai_limit: "ИИ сейчас недоступен",
};

/** «Синица подводит неделю» (P1-TASK-44): text only from the model, numbers stay in the report. */
export function WeeklySummary({ summary }: { summary: AiSummary }) {
  return (
    <div className="cabinet-card an-summary" aria-label="Синица подводит неделю">
      <h2 className="an-summary__title"><Sparkles size={18} aria-hidden="true" />Синица подводит неделю</h2>
      {summary.state === "ok" && summary.text ? (
        <>
          <p className="an-summary__text">{summary.text}</p>
          {summary.tips.length > 0 && <ul className="an-summary__tips">{summary.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul>}
        </>
      ) : (
        <p className="an-summary__note">{summary.state === "ok" ? SUMMARY_NOTE.ai_unavailable : SUMMARY_NOTE[summary.state]}</p>
      )}
    </div>
  );
}

const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
];
const STEPS: Record<string, string> = {
  menu_view: "Открыли меню",
  item_view: "Открыли позицию",
  item_add: "Добавили в выбор",
  choice_shown: "Показали на кассе",
};
const number = new Intl.NumberFormat("ru-RU");
const shortDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** «Аналитика» (P1-DOC-10): only real events of the period; empty periods show an action. */
export function AnalyticsSection({ context, onOpenMenu }: { context: CabinetContext; onOpenMenu: () => void }) {
  const [period, setPeriod] = useState<Period>("7d");
  const [scope, setScope] = useState<string | null>(null);
  const venueId = context.point.venue_id;
  const published = Boolean(context.point.current_published_version_id);
  const report = useQuery({
    queryKey: ["analytics", venueId, period, scope],
    queryFn: () => fetchAnalytics(venueId, period, scope),
    enabled: Boolean(venueId),
    staleTime: 60_000,
  });
  const summary = useQuery({
    queryKey: ["analytics-ai-summary", venueId, scope],
    queryFn: () => fetchAiSummary(venueId, scope),
    enabled: Boolean(venueId) && report.data?.has_data === true,
    staleTime: 3_600_000,
    retry: false,
  });
  const multi = context.venuePoints.length > 1;

  return (
    <section className="cabinet-section an" aria-labelledby="analytics-title">
      <div className="an-head">
        <h1 id="analytics-title" className="cabinet-title">Аналитика</h1>
        {report.data?.synthetic && <span className="an-demo"><FlaskConical size={16} aria-hidden="true" />демо-данные</span>}
      </div>
      <div className="an-filters" role="group" aria-label="Период и точка">
        {PERIODS.map((item) => (
          <Chip key={item.key} selected={period === item.key} onClick={() => setPeriod(item.key)}>{item.label}</Chip>
        ))}
        {multi && (
          <select className="an-select" aria-label="Точка" value={scope ?? ""} onChange={(event) => setScope(event.target.value || null)}>
            <option value="">Все точки</option>
            {context.venuePoints.map((point) => <option key={point.id} value={point.public_id}>{point.name}</option>)}
          </select>
        )}
      </div>

      {report.isPending && <AnalyticsSkeleton />}
      {report.isError && (
        <div className="cabinet-card">
          <EmptyState icon={<CircleAlert size={28} />} tone="danger" title="Аналитика не загрузилась" action={<Button onClick={() => void report.refetch()}>Повторить</Button>}>
            {report.error.message}
          </EmptyState>
        </div>
      )}
      {report.data && !report.data.has_data && (
        <div className="cabinet-card">
          <EmptyState
            icon={<BarChart3 size={28} />}
            title={published ? "Пока нет гостей — распечатайте QR" : "Сначала опубликуйте меню"}
            action={published
              ? <Link className="s-button s-button--primary" to={`/manage/${context.point.public_id}/more/qr`}><QrCode size={20} aria-hidden="true" />QR для столов</Link>
              : <Button onClick={onOpenMenu}>Открыть меню</Button>}
          >
            {published ? "Гости появятся здесь, когда откроют меню по QR." : "Аналитика считается по опубликованному меню."}
          </EmptyState>
          {published && <Link className="cabinet-inline-link" to={`/r/${context.point.public_id}`}><Eye size={18} aria-hidden="true" />Посмотреть как гость</Link>}
        </div>
      )}
      {report.data?.has_data && summary.data && <WeeklySummary summary={summary.data} />}
      {report.data?.has_data && <Report data={report.data} />}
    </section>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="an-grid" aria-busy="true" aria-label="Загружаем аналитику">
      <div className="an-kpis">{[0, 1, 2, 3].map((key) => <Skeleton key={key} height={88} />)}</div>
      <Skeleton height={200} />
    </div>
  );
}

function Report({ data }: { data: AnalyticsReport }) {
  const guests = data.guests.max_users + data.guests.web_sessions;
  return (
    <div className="an-grid">
      <div className="an-kpis">
        <Kpi label="Гости" value={number.format(guests)} note={`MAX ${number.format(data.guests.max_users)} · веб ${number.format(data.guests.web_sessions)}`} />
        <Kpi label="Выборы" value={number.format(data.choices)} note="сессии с «Моим выбором»" />
        <Kpi label="Конверсия в выбор" value={data.choice_rate === null ? "—" : `${data.choice_rate}%`} note="от открывших меню" />
        <Kpi label="Средний выбор" value={data.avg_choice_size === null ? "—" : String(data.avg_choice_size).replace(".", ",")} note="позиций" />
      </div>
      {data.period !== "today" && <DailyChart daily={data.daily} />}
      <Funnel funnel={data.funnel} />
      <div className="an-lists">
        <ItemList title="Чаще смотрят" items={data.top_viewed} metric="views" />
        <ItemList title="Чаще выбирают" items={data.top_chosen} metric="adds" />
        {data.looked_not_chosen.length > 0 && <ItemList title="Смотрят, но не выбирают" items={data.looked_not_chosen} metric="views" hint="Много просмотров, мало добавлений" />}
        <SearchList searches={data.empty_searches} />
        {data.recommendations.impressions > 0 && (
          <div className="cabinet-card an-card">
            <h2 className="an-h">Рекомендации</h2>
            <p className="an-line">Показы <b>{number.format(data.recommendations.impressions)}</b> · нажатия <b>{number.format(data.recommendations.clicks)}</b> · добавления <b>{number.format(data.recommendations.adds)}</b></p>
          </div>
        )}
        {data.d7_return.rate !== null && (
          <div className="cabinet-card an-card">
            <h2 className="an-h">Возвращаются через неделю</h2>
            <p className="an-line"><b>{data.d7_return.rate}%</b> гостей MAX ({data.d7_return.returned} из {data.d7_return.base})</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="an-kpi">
      <span className="an-kpi__label">{label}</span>
      <b className="an-kpi__value">{value}</b>
      <span className="an-kpi__note">{note}</span>
    </div>
  );
}

/** Guests who opened the menu per local day: one series, bars from a zero baseline. */
function DailyChart({ daily }: { daily: AnalyticsReport["daily"] }) {
  const max = Math.max(1, ...daily.map((day) => day.sessions));
  const peak = daily.reduce((best, day) => (day.sessions > best.sessions ? day : best), daily[0]);
  return (
    <figure className="cabinet-card an-card an-daily">
      <figcaption className="an-h">Открыли меню по дням</figcaption>
      <div className="an-bars" role="img" aria-label={`Больше всего — ${peak.sessions}, ${shortDay.format(new Date(peak.day))}`}>
        {daily.map((day) => (
          <div key={day.day} className="an-bars__col" data-tip={`${shortDay.format(new Date(day.day))}: ${day.sessions}`} title={`${shortDay.format(new Date(day.day))}: ${day.sessions}`}>
            <span className="an-bars__bar" style={{ height: `${day.sessions ? Math.max(3, (day.sessions / max) * 100) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="an-bars__axis" aria-hidden="true">
        <span>{shortDay.format(new Date(daily[0].day))}</span>
        <span>макс. {peak.sessions}</span>
        <span>{shortDay.format(new Date(daily[daily.length - 1].day))}</span>
      </div>
      <table className="an-sr">
        <caption>Открыли меню по дням</caption>
        <tbody>{daily.map((day) => <tr key={day.day}><th scope="row">{day.day}</th><td>{day.sessions}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

function Funnel({ funnel }: { funnel: AnalyticsReport["funnel"] }) {
  const top = Math.max(1, funnel[0]?.sessions ?? 0);
  return (
    <section className="cabinet-card an-card" aria-labelledby="an-funnel">
      <h2 id="an-funnel" className="an-h">Воронка по сессиям</h2>
      <ol className="an-funnel">
        {funnel.map((step) => (
          <li key={step.step} className="an-funnel__row">
            <span className="an-funnel__label">{STEPS[step.step] ?? step.step}</span>
            <span className="an-funnel__value"><b>{number.format(step.sessions)}</b>{step.rate !== null && <small>{step.rate}%</small>}</span>
            <span className="an-funnel__track" aria-hidden="true"><span className="an-funnel__bar" style={{ width: `${(step.sessions / top) * 100}%` }} /></span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ItemList({ title, items, metric, hint }: { title: string; items: ItemStat[]; metric: "views" | "adds"; hint?: string }) {
  const max = Math.max(1, ...items.map((item) => item[metric]));
  return (
    <section className="cabinet-card an-card">
      <h2 className="an-h">{title}</h2>
      {hint && <p className="cabinet-muted">{hint}</p>}
      {items.length === 0 ? <p className="cabinet-muted">Пока нет</p> : (
        <ol className="an-list">
          {items.map((item) => (
            <li key={item.item_key}>
              <span className="an-list__name">{item.name}</span>
              <span className="an-list__value">{metric === "views" ? `${item.views} просм.` : `${item.adds} выбр.`}</span>
              <span className="an-list__bar" style={{ width: `${(item[metric] / max) * 100}%` }} aria-hidden="true" />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SearchList({ searches }: { searches: AnalyticsReport["empty_searches"] }) {
  return (
    <section className="cabinet-card an-card">
      <h2 className="an-h"><Search size={18} aria-hidden="true" />Искали, но не нашли</h2>
      {searches.length === 0 ? <p className="cabinet-muted">Пустых поисков не было</p> : (
        <ol className="an-list">
          {searches.map((search) => (
            <li key={search.query}><span className="an-list__name">«{search.query}»</span><span className="an-list__value">{search.hits} раз</span></li>
          ))}
        </ol>
      )}
    </section>
  );
}
