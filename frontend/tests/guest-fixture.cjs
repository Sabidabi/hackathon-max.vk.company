// In-memory public API for guest menu 2.0 tests. Test fixture only — never a
// production backend. Serves only `/api/*`; the page itself comes from the Vite dev server
// (`guest-preview.html`). Points:
//   test-point format: `menus[]` with two tabs («Основное», «Завтраки»), light theme;
//   single-point — older format without `menus[]` (one menu), dark theme, no photos;
//   draft-point  — nothing published (404 «Site not published»);
//   closed-point — published, but no menu is shown now (`menus: []`, `version: null`).
// Signed in, the guest administers test-point (`GET /api/v1/restaurants`).
// `POST /api/__fixture/republish` publishes a new version of test-point: new ids, Латте dearer.
const http = require("node:http");
const { randomUUID } = require("node:crypto");

function createState() {
  const option = (name, price, extra = {}) => ({ id: randomUUID(), name, price_minor: price, min_quantity: 0, max_quantity: 1, default_quantity: 0, is_available: true, price_by_variant: {}, ...extra });
  const plain = () => ({ variants: [], default_variant_id: null, modifier_groups: [] });
  const item = (name, price, extra = {}) => ({ id: randomUUID(), item_key: randomUUID(), name, description: null, image_url: null, price_minor: price, currency: "RUB", weight_text: null, ingredients: null, allergens: [], is_available: true, source_confidence: null, configuration: plain(), ...extra });
  const media = (name) => `/api/__fixture/media/${encodeURIComponent(name)}.svg`;

  const latte = item("Латте", 19000, { description: "Эспрессо и молоко с нежной пеной", image_url: media("Латте"), weight_text: "250 мл" });
  const small = randomUUID(); const large = randomUUID();
  latte.configuration = {
    variants: [
      { id: small, name: "250 мл", price_minor: 19000, weight_text: "250 мл", is_available: true },
      { id: large, name: "350 мл", price_minor: 23000, weight_text: "350 мл", is_available: true },
    ],
    default_variant_id: small,
    modifier_groups: [
      { id: randomUUID(), name: "Молоко", min_quantity: 1, max_quantity: 1, options: [option("Обычное", 0), option("Овсяное", 5000), option("Миндальное", 6000, { is_available: false })] },
      { id: randomUUID(), name: "Сироп", min_quantity: 0, max_quantity: 2, options: [option("Карамель", 3000, { max_quantity: 2 }), option("Ваниль", 3000)] },
    ],
  };
  const cappuccino = item("Капучино", 18000, { description: "Классика на двойном эспрессо", image_url: media("Капучино"), weight_text: "250 мл" });
  // Mixed section: two items with photos (tiles), two without (rows; no stand-in pictures).
  const flat = item("Флэт уайт", 21000, { description: "Двойной ристретто и бархатное молоко", weight_text: "200 мл", allergens: ["молоко"] });
  const americano = item("Американо", 14000, { description: "Эспрессо и горячая вода", weight_text: "250 мл", is_available: false });
  const croissant = item("Круассан", 17000, { description: "Сливочное масло, хрустящие слои", weight_text: "80 г" });
  const cinnabon = item("Синнабон", 22000, { description: "Булочка с корицей и сливочным кремом", weight_text: "120 г" });
  const eclair = item("Эклер ванильный", 15000, { weight_text: "70 г", is_available: false });
  const tea = item("Чай улун", 16000, { description: "Молочный улун, чайник 400 мл", weight_text: "400 мл" });
  const cocoa = item("Какао", 20000, { description: "Можно на овсяном молоке", weight_text: "300 мл" });
  const syrniki = item("Сырники", 32000, { description: "Со сметаной и ягодным соусом", weight_text: "220 г" });
  const omelette = item("Омлет с сыром", 29000, { weight_text: "200 г" });
  const mainSections = [
    { id: randomUUID(), name: "Кофе", items: [latte, cappuccino, flat, americano] },
    { id: randomUUID(), name: "Выпечка", items: [croissant, cinnabon, eclair] },
    { id: randomUUID(), name: "Другие напитки", items: [tea, cocoa] },
  ];
  const breakfastSections = [{ id: randomUUID(), name: "Завтраки", items: [syrniki, omelette] }];
  return {
    version: 3,
    menus: [
      { menu_id: randomUUID(), title: "Основное", version: 3, published_at: new Date().toISOString(), sections: mainSections },
      { menu_id: randomUUID(), title: "Завтраки", version: 1, published_at: new Date().toISOString(), sections: breakfastSections },
    ],
  };
}

const lightSite = { template: "modern", theme_mode: "light", primary_color: "#1F6B57", background_color: "#F3F5F4", surface_color: "#FFFFFF", text_color: "#16201C", icon_color: "#D1495B", background_image_url: null, background_overlay: 0, font_scale: 1, tagline: null, about: null, phone: null, hours: "Ежедневно 08:00–21:00", booking_url: null, logo_url: null, cover_url: null, gallery_urls: [], blocks: [] };
const darkSite = { ...lightSite, template: "noir", theme_mode: "dark", primary_color: "#E0B25C", background_color: "#121212", surface_color: "#1E1E1E", text_color: "#F2F2F2", icon_color: "#E0B25C", hours: "Пн–Пт 09:00–20:00" };

function reidentify(menus) {
  const clone = structuredClone(menus);
  for (const menu of clone) {
    menu.version += 1;
    for (const section of menu.sections) {
      section.id = randomUUID();
      for (const item of section.items) {
        item.id = randomUUID();
        const variantIds = new Map();
        for (const variant of item.configuration.variants) {
          const next = randomUUID();
          variantIds.set(variant.id, next);
          variant.id = next;
          if (item.name === "Латте") variant.price_minor += 2000;
        }
        if (item.configuration.default_variant_id) item.configuration.default_variant_id = variantIds.get(item.configuration.default_variant_id);
        for (const group of item.configuration.modifier_groups) {
          group.id = randomUUID();
          for (const option of group.options) option.id = randomUUID();
        }
      }
    }
  }
  return clone;
}

function quote(menus, body) {
  const product = menus.flatMap((menu) => menu.sections.flatMap((section) => section.items)).find((item) => item.id === body.item_id);
  if (!product || !product.is_available) return [409, { detail: "Позиция недоступна или меню обновилось" }];
  const config = product.configuration;
  const selected = new Map((body.modifiers || []).map((entry) => [entry.option_id, entry.quantity]));
  let price = product.price_minor;
  if (config.variants.length) {
    const variant = config.variants.find((candidate) => candidate.id === body.variant_id && candidate.is_available);
    if (!variant) return [422, { detail: "Выберите размер" }];
    price = variant.price_minor;
  }
  for (const group of config.modifier_groups) {
    const count = group.options.reduce((sum, option) => sum + (selected.get(option.id) || 0), 0);
    if (count < group.min_quantity || count > group.max_quantity) return [422, { detail: `«${group.name}»: выберите от ${group.min_quantity} до ${group.max_quantity}` }];
    for (const option of group.options) {
      const quantity = selected.get(option.id) || 0;
      if (quantity && !option.is_available) return [422, { detail: `«${option.name}» нет в наличии` }];
      price += quantity * (option.price_by_variant[body.variant_id] ?? option.price_minor);
    }
  }
  // Ignores any client amount: the price is computed from the published configuration only.
  const quantity = Number.isInteger(body.quantity) && body.quantity >= 1 && body.quantity <= 99 ? body.quantity : 1;
  return [200, { unit_price_minor: price, total_price_minor: price * quantity, quantity, currency: "RUB" }];
}

// «Синица, что взять?» of the fixture: a keyword stand-in for the server (the real grounding,
// ID filter and limits are covered by backend pytest). Only available positions are offered.
const ASK_WORDS = [
  [/без кофеина|не кофе/, ["Какао", "Чай улун"]],
  [/сладк|десерт/, ["Синнабон", "Круассан", "Какао"]],
  [/тёпл|тепл|горяч/, ["Латте", "Какао", "Чай улун"]],
];
function ask(menus, question) {
  const items = menus.flatMap((menu) => menu.sections.flatMap((section) => section.items.map((item) => ({ item, section: section.name, menu_id: menu.menu_id }))))
    .filter(({ item }) => item.is_available);
  const text = String(question || "").toLowerCase();
  const names = ASK_WORDS.find(([pattern]) => pattern.test(text))?.[1] ?? [];
  const found = names.map((name) => items.find(({ item }) => item.name === name)).filter(Boolean);
  const picks = (found.length ? found : items.slice(0, 2)).slice(0, 3);
  return picks.map(({ item, section, menu_id }) => {
    const prices = item.configuration.variants.filter((variant) => variant.is_available).map((variant) => variant.price_minor);
    return { id: item.id, item_key: item.item_key ?? item.id, menu_id, name: item.name, section, price_minor: prices.length ? Math.min(...prices) : item.price_minor, has_sizes: prices.length > 1, image_url: item.image_url };
  });
}

// Stand-in for a venue's uploaded photo, explicitly labelled as a test image: the repository
// has no real dish photos. Only items that «have a photo» get one; the rest have none.
function mediaSvg(name) {
  const safe = name.replace(/[<>&"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#3b2a20"/><rect x="0" y="290" width="400" height="110" fill="#2a1d15"/><text x="60" y="336" font-family="Arial" font-size="28" font-weight="700" fill="#f6efe8">${safe}</text><text x="60" y="370" font-family="Arial" font-size="18" fill="#cdbfb3">Тестовое фото</text></svg>`;
}

function createGuestFixture({ port = Number(process.env.GUEST_FIXTURE_PORT || 5391) } = {}) {
  let state = createState();
  const single = createState();
  // The older server format has no stable item keys; this bar has no photos at all.
  for (const menu of single.menus) for (const section of menu.sections) for (const item of section.items) {
    delete item.item_key;
    item.image_url = null;
  }
  let favorite = { is_favorite: false, notifications_enabled: false };
  const counters = { recent: 0, quotes: 0, login: 0, asks: 0 };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const p = url.pathname;
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 1_000_000) throw new Error("Too large");
      }
      const body = text ? JSON.parse(text) : {};
      const json = (data, status = 200, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
        res.end(JSON.stringify(data));
      };
      const signedIn = /(?:^|;\s*)guest_session=1/.test(req.headers.cookie || "");

      if (p.startsWith("/api/__fixture/media/")) {
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
        return res.end(mediaSvg(decodeURIComponent(p.split("/").pop().replace(/\.svg$/, ""))));
      }
      if (p === "/api/__fixture/republish" && req.method === "POST") {
        state = { ...state, menus: reidentify(state.menus) };
        return json({ ok: true });
      }
      if (p === "/api/__fixture/counters") return json(counters);
      if (p === "/api/__fixture/reset" && req.method === "POST") {
        state = createState();
        return json({ ok: true });
      }
      if (p === "/api/v1/auth/me") return signedIn ? json({ id: "guest-user", max_user_id: 7, display_name: "Гость", username: null, language_code: "ru" }) : json({ detail: "Not authenticated" }, 401);
      if (p === "/api/v1/auth/max" && req.method === "POST") {
        counters.login += 1;
        if (!body.init_data) return json({ detail: "Bad launch" }, 401);
        return json({ id: "guest-user", max_user_id: 7, display_name: "Гость", username: null, language_code: "ru" }, 200, { "Set-Cookie": "guest_session=1; Path=/; HttpOnly; SameSite=Lax" });
      }
      if (p === "/api/v1/auth/bootstrap") return json({ max_auth_configured: true, development_auth: false, max_launch_url: "https://max.ru/test_bot" });
      if (p === "/api/v1/restaurants" && req.method === "GET") {
        if (!signedIn) return json({ detail: "Not authenticated" }, 401);
        return json([{ id: "fixture-point", public_id: "test-point", name: "Покровка, 12" }]);
      }
      if (p === "/api/v1/me/recent" && req.method === "POST") {
        if (!signedIn) return json({ detail: "Not authenticated" }, 401);
        counters.recent += 1;
        res.writeHead(204);
        return res.end();
      }
      const match = /^\/api\/v1\/public\/restaurants\/([^/]+)\/(menu|menu\/quote|favorite|ask)$/.exec(p);
      if (match) {
        const [, publicId, kind] = match;
        const point = publicId === "test-point" ? state : publicId === "single-point" ? single : null;
        if (kind === "favorite") {
          if (!signedIn) return json({ detail: "Not authenticated" }, 401);
          if (req.method === "PUT") favorite = body.is_favorite ? { is_favorite: true, notifications_enabled: Boolean(body.notifications_enabled) } : { is_favorite: false, notifications_enabled: false };
          return json(favorite);
        }
        if (publicId === "draft-point") return json({ detail: "Site not published" }, 404);
        if (publicId === "closed-point" && kind === "menu") {
          return json({ restaurant: { public_id: "closed-point", name: "Ночная пекарня", description: null, address: null, venue_name: "Ночная пекарня", timezone: "Europe/Moscow" }, site: lightSite, version: null, published_at: null, sections: [], menus: [] });
        }
        if (!point) return json({ detail: "Menu not found" }, 404);
        if (kind === "ask") {
          counters.asks += 1;
          const menus = publicId === "single-point" ? single.menus.slice(0, 1) : point.menus;
          const items = ask(menus, body.question);
          if (/лимит/.test(String(body.question))) {
            return json({ detail: { code: "ai_limit_user", message: "Лимит запросов к ИИ на сегодня исчерпан. Попробуйте завтра.", items } }, 429);
          }
          if (publicId === "single-point") return json({ source: "fallback", provider: null, reason: "", notice: "ИИ сейчас недоступен — вот что можно взять", items });
          return json({ source: "ai", provider: "mock", reason: "Демо-ответ без настоящего ИИ: подобрали по словам вашего запроса.", notice: null, items });
        }
        if (kind === "menu/quote") {
          counters.quotes += 1;
          const menus = publicId === "single-point" ? single.menus.slice(0, 1) : point.menus;
          const [status, payload] = quote(menus, body);
          return json(payload, status);
        }
        if (publicId === "single-point") {
          const first = single.menus[0];
          return json({
            restaurant: { public_id: "single-point", name: "Бар Ночь", description: null, address: "Санкт-Петербург, Рубинштейна, 3" },
            site: darkSite,
            version: first.version,
            published_at: first.published_at,
            sections: first.sections,
            assistant: { available: false, provider: null },
          });
        }
        const first = point.menus[0];
        return json({
          restaurant: { public_id: "test-point", name: "Покровка, 12", description: "Кофе и свежая выпечка", address: "Москва, Покровка, 12", venue_name: "Кофейня Север", timezone: "Europe/Moscow" },
          site: lightSite,
          version: first.version,
          published_at: first.published_at,
          sections: first.sections,
          menus: point.menus,
          assistant: { available: true, provider: "mock" },
        });
      }
      return json({ detail: "Недоступно в фикстуре гостевого меню" }, 404);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: error.message }));
    }
  });
  return {
    server,
    counters,
    port,
    listen: () => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createGuestFixture };

if (require.main === module) {
  const fixture = createGuestFixture();
  void fixture.listen().then(() => console.log(`Guest fixture API only: http://127.0.0.1:${fixture.port}/api`));
}
