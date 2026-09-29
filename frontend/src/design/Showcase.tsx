// Dev-only showcase of the «Синица» design system. Never shipped:
// AppRoutes loads it only when `import.meta.env.DEV` is true. `?screen=` opens a service
// screen full-page: splash | splash-timeout | auth-error | load-error | open-in-max |
// open-in-max-unconfigured | not-found.
import { BarChart3, Coffee, Ellipsis, Heart, Palette, Plus, Search, Settings, Share2, ShoppingBag, SquareMenu, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { BrandLockup, BrandMark } from "./brand";
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  RollingNumber,
  Select,
  Sheet,
  Skeleton,
  Spinner,
  Switch,
  TabBar,
  Textarea,
  TextInput,
  Toast,
} from "./components";
import { AuthError, LoadError, NotFound, OpenInMax, Splash } from "./screens";
import { flip, flyToTarget, measure, type Snapshot } from "./motion";
import { showToast } from "./toast";
import "./showcase.css";

const SAMPLE_LAUNCH_URL = "https://max.ru/sinitsa_demo_bot";

function Screen({ name }: { name: string }) {
  switch (name) {
    case "splash":
      return <Splash timeoutMs={60 * 60 * 1000} />;
    case "splash-timeout":
      return <Splash timeoutMs={0} />;
    case "auth-error":
      return <AuthError onRestart={() => showToast("Перезапуск (витрина)")} />;
    case "load-error":
      return <LoadError onRetry={() => showToast("Повтор (витрина)")} />;
    case "open-in-max":
      return <OpenInMax launchUrl={SAMPLE_LAUNCH_URL} startPayload="manage_sever" />;
    case "open-in-max-unconfigured":
      return <OpenInMax launchUrl={null} />;
    default:
      return <NotFound />;
  }
}

/** «Движение» block: every reference animation of the spec on one screen. */
function MotionDemo() {
  const [status, setStatus] = useState<"idle" | "progress" | "success">("idle");
  const [changes, setChanges] = useState(3);
  const [rows, setRows] = useState(["Латте", "Капучино"]);
  const [stopped, setStopped] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>();
  const [count, setCount] = useState(0);
  const [originSheet, setOriginSheet] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const before = useRef<Snapshot | null>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const bagRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!before.current || !listRef.current) return;
    flip(before.current, listRef.current.children);
    before.current = null;
  }, [rows]);

  const publish = () => {
    setStatus("progress");
    window.setTimeout(() => {
      setStatus("success");
      setChanges(0);
      showToast("Опубликовано", { tone: "success" });
      window.setTimeout(() => setStatus("idle"), 1_200);
    }, 900);
  };
  const toggleStop = () => {
    const next = !stopped;
    setStopped(next);
    if (next) showToast("Круассан скрыт на Тверской", { action: { label: "Отменить", onClick: () => setStopped(false) } });
  };

  return (
    <section className="ui-block" aria-labelledby="ui-motion">
      <h2 id="ui-motion">Движение</h2>
      <div className="ui-row">
        <Button status={status} onClick={publish} disabled={status === "idle" && changes === 0} aria-label={`Опубликовать изменения: ${changes}`}>
          Опубликовать изменения (<RollingNumber value={changes} />)
        </Button>
        <Button variant="secondary" onClick={() => setChanges((value) => value + 1)}>Ещё изменение</Button>
      </div>
      <div className="ui-card">
        <div className={["ui-motion-row", stopped && "ui-motion-row--stopped"].filter(Boolean).join(" ")}>
          <span>Круассан</span>
          <Switch compact checked={!stopped} onChange={toggleStop} label="Круассан — наличие" />
        </div>
      </div>
      <div className="ui-card">
        <ul className="ui-motion-list" ref={listRef}>
          {rows.map((row) => <li key={row}>{row}</li>)}
        </ul>
        <Button
          variant="ghost"
          icon={<Plus size={20} />}
          onClick={() => {
            before.current = listRef.current ? measure(listRef.current.children) : null;
            setRows((current) => [`Позиция ${current.length + 1}`, ...current]);
          }}
        >
          Добавить строку сверху
        </Button>
      </div>
      <div className="ui-grid">
        <TextInput
          label="Промокод"
          value={code}
          onChange={(event) => { setCode(event.target.value); setCodeError(undefined); }}
          error={codeError}
        />
        <Button variant="secondary" onClick={() => setCodeError(code.trim() ? undefined : "Введите промокод")}>Проверить</Button>
      </div>
      <div className="ui-row ui-row--center">
        <div ref={tileRef} className="ui-motion-tile"><Coffee size={28} aria-hidden="true" /></div>
        <Button variant="secondary" onClick={() => { void flyToTarget(tileRef.current, bagRef.current); setCount((value) => value + 1); }}>В мой выбор</Button>
        <span ref={bagRef} className="ui-motion-bag"><ShoppingBag size={22} aria-hidden="true" /><RollingNumber value={count} /></span>
      </div>
      <button ref={rowRef} type="button" className="ui-motion-origin" onClick={() => setOriginSheet(true)}>
        <Coffee size={20} aria-hidden="true" /> Латте · 190 ₽ — открыть карточку
      </button>
      <Sheet open={originSheet} onClose={() => setOriginSheet(false)} origin={rowRef.current} title="Латте">
        <p className="ui-muted">Карточка выросла из строки и вернётся в неё при закрытии. На телефоне её можно смахнуть вниз.</p>
      </Sheet>
    </section>
  );
}

const CATEGORIES = ["Кофе", "Чай", "Выпечка", "Завтраки", "Десерты", "Сезонное меню", "Без кофеина"];
type Tab = "menu" | "analytics" | "design" | "more";

export default function Showcase() {
  const [params] = useSearchParams();
  const [category, setCategory] = useState("Кофе");
  const [milk, setMilk] = useState("Овсяное");
  const [available, setAvailable] = useState(true);
  const [notify, setNotify] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("menu");
  const [name, setName] = useState("");
  const screen = params.get("screen");
  if (screen) return <Screen name={screen} />;

  return (
    <div className="ui-page">
      <main className="ui-showcase">
        <header className="ui-showcase__header">
          <BrandLockup width={160} />
          <p>Витрина компонентов · только в режиме разработки</p>
        </header>

        <section className="ui-block" aria-labelledby="ui-buttons">
          <h2 id="ui-buttons">Кнопки</h2>
          <div className="ui-row">
            <Button icon={<Share2 size={20} />}>Поделиться меню</Button>
            <Button variant="secondary">Посмотреть как гость</Button>
            <Button variant="ghost" icon={<Plus size={20} />}>Добавить позицию</Button>
            <Button variant="danger" icon={<Trash2 size={20} />}>Удалить</Button>
          </div>
          <div className="ui-row">
            <Button
              loading={loading}
              onClick={() => {
                setLoading(true);
                window.setTimeout(() => {
                  setLoading(false);
                  showToast("Изменения опубликованы");
                }, 1200);
              }}
            >
              Опубликовать изменения (3)
            </Button>
            <Button disabled>Нет изменений</Button>
          </div>
          <Button fullWidth>Показать на кассе</Button>
          <div className="ui-row">
            <IconButton aria-label="Поиск по меню" icon={<Search size={22} />} />
            <IconButton aria-label="Добавить в избранное" icon={<Heart size={22} />} variant="tonal" />
            <IconButton aria-label="Настройки" icon={<Settings size={22} />} />
            <IconButton aria-label="Ещё" icon={<Ellipsis size={22} />} disabled />
          </div>
        </section>

        <section className="ui-block" aria-labelledby="ui-chips">
          <h2 id="ui-chips">Чипы</h2>
          <div className="ui-scroller" role="group" aria-label="Категории меню">
            {CATEGORIES.map((item) => (
              <Chip key={item} selected={item === category} onClick={() => setCategory(item)}>{item}</Chip>
            ))}
          </div>
          <div className="ui-row" role="group" aria-label="Молоко">
            {["Обычное", "Овсяное", "Миндальное"].map((item) => (
              <Chip key={item} selected={item === milk} onClick={() => setMilk(item)} icon={<Coffee size={18} />}>{item}</Chip>
            ))}
          </div>
        </section>

        <section className="ui-block" aria-labelledby="ui-form">
          <h2 id="ui-form">Поля и переключатели</h2>
          <div className="ui-grid">
            <TextInput
              label="Название позиции"
              required
              placeholder="Например, Раф лавандовый"
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={name.trim() ? undefined : "Введите название — без него позиция не попадёт в меню"}
            />
            <TextInput label="Цена, ₽" inputMode="decimal" defaultValue="190" hint="Цену для гостя считает сервер" />
            <Select label="Раздел" defaultValue="coffee">
              <option value="coffee">Кофе</option>
              <option value="bakery">Выпечка</option>
              <option value="new">Новый раздел…</option>
            </Select>
            <Textarea label="Описание" placeholder="Эспрессо, молоко, лавандовый сироп" rows={3} />
          </div>
          <div className="ui-card">
            <Switch checked={available} onChange={setAvailable} label="В наличии" description="Гости видят позицию и могут выбрать её" />
            <Switch checked={notify} onChange={setNotify} label="Уведомлять о новинках" />
            <Switch checked={false} onChange={() => undefined} label="Заказ к столику" description="Появится после хакатона" disabled />
          </div>
        </section>

        <section className="ui-block" aria-labelledby="ui-feedback">
          <h2 id="ui-feedback">Обратная связь</h2>
          <div className="ui-row">
            <Button variant="secondary" onClick={() => setSheetOpen(true)}>Открыть панель</Button>
            <Button variant="secondary" onClick={() => showToast("Ссылка скопирована")}>Показать уведомление</Button>
          </div>
          <div className="ui-stack">
            <Toast>Изменения сохранены</Toast>
            <Toast tone="success">Меню опубликовано</Toast>
            <Toast tone="danger" action={<Button variant="secondary">Повторить</Button>}>Не удалось сохранить</Toast>
          </div>
          <div className="ui-row ui-row--center">
            <Spinner label="Загружаем меню" />
            <Spinner size={32} />
          </div>
        </section>

        <MotionDemo />

        <section className="ui-block" aria-labelledby="ui-states">
          <h2 id="ui-states">Загрузка и пустые состояния</h2>
          <div className="ui-card ui-skeleton-card" aria-busy="true" aria-label="Позиция загружается">
            <Skeleton width={72} height={72} radius="card" />
            <div className="ui-stack">
              <Skeleton width="70%" height={20} />
              <Skeleton width="45%" />
              <Skeleton width={96} height={32} radius="pill" />
            </div>
          </div>
          <div className="ui-card">
            <EmptyState
              icon={<SquareMenu size={28} />}
              title="В меню пока нет позиций"
              action={<Button icon={<Plus size={20} />}>Добавить позицию</Button>}
            >
              Добавьте первую позицию или загрузите фото меню.
            </EmptyState>
          </div>
        </section>

        <section className="ui-block" aria-labelledby="ui-nav">
          <h2 id="ui-nav">Навигация</h2>
          <div className="ui-card ui-card--flush">
            <TabBar<Tab>
              label="Разделы кабинета"
              value={tab}
              onChange={setTab}
              items={[
                { key: "menu", label: "Меню", icon: <SquareMenu size={24} />, badge: 3 },
                { key: "analytics", label: "Аналитика", icon: <BarChart3 size={24} /> },
                { key: "design", label: "Оформление", icon: <Palette size={24} /> },
                { key: "more", label: "Ещё", icon: <Ellipsis size={24} /> },
              ]}
            />
          </div>
        </section>

        <section className="ui-block" aria-labelledby="ui-brand">
          <h2 id="ui-brand">Логотип и служебные экраны</h2>
          <div className="ui-row ui-row--center">
            <BrandMark size={64} />
            <BrandMark size={32} />
            <BrandLockup width={200} />
            <span className="ui-dark"><BrandLockup width={160} tone="white" /></span>
          </div>
          <ul className="ui-links">
            {["splash", "splash-timeout", "auth-error", "load-error", "open-in-max", "open-in-max-unconfigured", "not-found"].map((item) => (
              <li key={item}><a href={`/__ui?screen=${item}`}>{item}</a></li>
            ))}
          </ul>
        </section>

        <Sheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="Латте"
          footer={<Button fullWidth onClick={() => setSheetOpen(false)}>Готово</Button>}
        >
          <div className="ui-stack">
            <p className="ui-muted">Эспрессо и молочная пена. Закрывается по Escape, по фону и нативной кнопкой «Назад» в MAX.</p>
            <div className="ui-row" role="group" aria-label="Молоко">
              {["Обычное", "Овсяное"].map((item) => (
                <Chip key={item} selected={item === milk} onClick={() => setMilk(item)}>{item}</Chip>
              ))}
            </div>
            <TextInput label="Комментарий" placeholder="Без сахара" />
          </div>
        </Sheet>
      </main>
    </div>
  );
}
