// Invitation screen, Home and start_param routing against the built app and the
// in-memory fixture API. Browser fixture only: it proves screens and HTTP contracts, not MAX.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const output = path.resolve(process.env.TEST_OUTPUT || "test-results");
const port = Number(process.env.LAUNCH_TEST_PORT || 5211);
const baseUrl = `http://127.0.0.1:${port}`;
const widths = [320, 390, 1280];
// Must match INVITE_TOKENS in fixture-server.cjs.
const TOKENS = {
  valid: "fixture-invite-valid-000000000000000001",
  used: "fixture-invite-used-0000000000000000001",
  foreign: "fixture-invite-foreign-00000000000000001",
  admin: "fixture-invite-admin-000000000000000001",
};
fs.mkdirSync(output, { recursive: true });

async function waitForFixture() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture server did not start");
}

/** Waits for finite animations (entrance cascade) to finish so screenshots show the settled screen. */
const settled = (page) => page.waitForFunction(() => document.getAnimations()
  .every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity), null, { timeout: 3_000 });

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function newPage(browser, width, setup) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  if (setup) await setup(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  return { context, page, errors };
}

async function touchTargetsOk(page, scope) {
  const small = await page.locator(scope).evaluate((root) =>
    Array.from(root.querySelectorAll("button, a"))
      .map((element) => ({ text: element.textContent.trim(), box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && (box.width < 44 || box.height < 44))
      .map(({ text, box }) => `${text} ${Math.round(box.width)}×${Math.round(box.height)}`));
  assert.deepEqual(small, [], "Touch targets under 44×44");
}

async function verifyInviteScreens(browser) {
  for (const width of widths) {
    const { context, page, errors } = await newPage(browser, width);
    try {
      await page.goto(`${baseUrl}/invite/${TOKENS.valid}`);
      await page.getByRole("heading", { name: "Вас приглашают администратором «Пекарня Юг»" }).waitFor({ timeout: 5_000 });
      await page.getByText("Анна", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Принять", exact: true }).waitFor();
      await page.getByRole("button", { name: "Не сейчас", exact: true }).waitFor();
      assert.ok(await noOverflow(page), `Invite screen overflows at ${width}px`);
      await touchTargetsOk(page, ".invite-screen");
      await settled(page);
      await page.screenshot({ path: path.join(output, `invite-${width}.png`), fullPage: true });

      await page.goto(`${baseUrl}/invite/${TOKENS.used}`);
      await page.getByRole("heading", { name: "Приглашение недействительно" }).waitFor({ timeout: 5_000 });
      await page.getByText("Попросите администратора прислать новую", { exact: false }).waitFor();
      assert.ok(await noOverflow(page));
      await settled(page);
      await page.screenshot({ path: path.join(output, `invite-invalid-${width}.png`), fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  const { context, page, errors } = await newPage(browser, 390);
  try {
    await page.goto(`${baseUrl}/invite/${TOKENS.foreign}`);
    await page.getByRole("heading", { name: "Приглашение для другого аккаунта" }).waitFor({ timeout: 5_000 });
    await page.goto(`${baseUrl}/invite/${TOKENS.admin}`);
    await page.getByRole("heading", { name: "Вы уже администратор «Кофейня Север»" }).waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Открыть кабинет" }).click();
    await page.waitForURL(`${baseUrl}/manage/test-point`);
    await page.goto(`${baseUrl}/invite/short`);
    await page.getByRole("heading", { name: "Приглашение недействительно" }).waitFor({ timeout: 5_000 });

    // «Не сейчас» leaves without accepting.
    await page.goto(`${baseUrl}/invite/${TOKENS.valid}`);
    await page.getByRole("button", { name: "Не сейчас", exact: true }).click();
    await page.waitForURL(`${baseUrl}/`);

    // «Принять»: token goes in the body (not the URL path), then the new venue's cabinet opens.
    const acceptRequests = [];
    page.on("request", (request) => { if (request.url().includes("/invites/") && request.method() === "POST") acceptRequests.push(request); });
    await page.goto(`${baseUrl}/invite/${TOKENS.valid}`);
    await page.getByRole("button", { name: "Принять", exact: true }).click();
    await page.waitForURL(`${baseUrl}/manage/yug-point`, { timeout: 5_000 });
    assert.equal(acceptRequests.length, 1);
    assert.equal(new URL(acceptRequests[0].url()).pathname, "/api/v1/invites/accept");
    assert.deepEqual(JSON.parse(acceptRequests[0].postData()), { token: TOKENS.valid });

    // The used link now reads as invalid.
    await page.goto(`${baseUrl}/invite/${TOKENS.valid}`);
    await page.getByRole("heading", { name: "Приглашение недействительно" }).waitFor({ timeout: 5_000 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// --- MAX launch -------------------------------------------------------------------

/** Marks the first-launch intro as already seen (localStorage fallback of DeviceStorage). */
function presetIntroSeen() {
  try { window.localStorage.setItem("sinitsa.intro.v1", "1"); } catch {}
}

/** Signed-looking initData; the fixture does not check signatures (the backend does). */
function initDataFor(startParam) {
  const fields = { auth_date: "1790330000", query_id: "fixture", user: JSON.stringify({ id: 1, first_name: "Демо" }), hash: "fixture" };
  if (startParam !== null && startParam !== undefined) fields.start_param = startParam;
  return new URLSearchParams(fields).toString();
}

/**
 * A page inside the MAX mock. `mode`: `fragment` — launch data only in `#WebAppData` (no Bridge
 * object), `bridge` — `window.WebApp` from the Bridge script, `late` — the Bridge appears 600 ms
 * after start. Counts `ready()` calls and serves `openCodeReader` from `window.__scanResult`.
 */
async function maxPage(browser, width, { startParam = null, mode = "bridge", scanResult = null, introSeen = true } = {}) {
  const initData = initDataFor(startParam);
  const bridge = `{ initData: ${JSON.stringify(initData)}, initDataUnsafe: { start_param: ${JSON.stringify(startParam)} }, platform: "android", version: "26.2.8",
    ready() { window.__readyCalls = (window.__readyCalls || 0) + 1; }, expand() {},
    openCodeReader() { return Promise.resolve(window.__scanResult); },
    BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} } }`;
  const script = mode === "fragment" ? "window.__readyCalls = 0;"
    : mode === "late" ? `window.__readyCalls = 0; setTimeout(() => { window.WebApp = ${bridge}; }, 600);`
      : `window.__readyCalls = 0; window.WebApp = ${bridge};`;
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: script }));
  await context.addInitScript((value) => { window.__scanResult = value; }, scanResult);
  // The first-launch intro is covered by intro.smoke.cjs; here Home is expected.
  if (introSeen) await context.addInitScript(presetIntroSeen);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  const hash = mode === "fragment" ? `#WebAppData=${encodeURIComponent(initData)}&WebAppPlatform=android&WebAppVersion=26.2.8` : "";
  return { context, page, errors, url: `${baseUrl}/${hash}` };
}

async function menuItemShortId() {
  const menu = await (await fetch(`${baseUrl}/api/v1/public/restaurants/test-point/menu`)).json();
  const latte = menu.sections.flatMap((section) => section.items).find((item) => item.name === "Латте");
  return latte.id.replace(/-/g, "").slice(0, 8);
}

async function verifyStartParamRouting(browser) {
  const shortId = await menuItemShortId();
  const cases = [
    { startParam: "r_test-point", mode: "fragment", path: "/r/test-point", ready: (page) => page.getByLabel("Поиск по меню").waitFor({ timeout: 5_000 }) },
    { startParam: `r_test-point_i_${shortId}`, mode: "bridge", path: `/r/test-point/i/${shortId}`, ready: (page) => page.getByRole("dialog", { name: "Латте" }).waitFor({ timeout: 5_000 }) },
    { startParam: "manage_test-point", mode: "bridge", path: "/manage/test-point", ready: (page) => page.getByRole("button", { name: "Действия с меню" }).waitFor({ timeout: 5_000 }) },
    { startParam: `inv_${TOKENS.valid}`, mode: "bridge", path: `/invite/${TOKENS.valid}`, ready: (page) => page.getByRole("heading", { name: "Вас приглашают администратором «Пекарня Юг»" }).waitFor({ timeout: 5_000 }) },
    { startParam: "connect", mode: "bridge", path: "/connect", ready: (page) => page.getByRole("heading", { name: "Подключить заведение" }).waitFor({ timeout: 5_000 }) },
    // Late Bridge: the start parameter arrives with `window.WebApp` after the first render.
    { startParam: "r_test-point", mode: "late", path: "/r/test-point", ready: (page) => page.getByLabel("Поиск по меню").waitFor({ timeout: 5_000 }) },
    // Broken or missing parameter: Home, never an error.
    { startParam: "r_test-point x", mode: "fragment", path: "/", ready: (page) => page.getByRole("heading", { name: "Здравствуйте, Демо" }).waitFor({ timeout: 5_000 }) },
    { startParam: " r_test-point", mode: "bridge", path: "/", ready: (page) => page.getByRole("heading", { name: "Здравствуйте, Демо" }).waitFor({ timeout: 5_000 }) },
    { startParam: null, mode: "bridge", path: "/", ready: (page) => page.getByRole("heading", { name: "Здравствуйте, Демо" }).waitFor({ timeout: 5_000 }) },
  ];
  for (const item of cases) {
    const { context, page, errors, url } = await maxPage(browser, 390, item);
    try {
      await page.goto(url);
      await item.ready(page);
      assert.equal(new URL(page.url()).pathname, item.path, `start_param ${JSON.stringify(item.startParam)} (${item.mode})`);
      assert.equal(await page.getByRole("heading", { name: "Синица", exact: true }).count(), 0, "Inside MAX the landing is never shown");
      if (item.mode !== "fragment") {
        for (let i = 0; i < 20 && !(await page.evaluate(() => window.__readyCalls)); i++) await page.waitForTimeout(50);
        assert.equal(await page.evaluate(() => window.__readyCalls), 1, `ready() once for ${item.startParam}`);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  // `manage_<id>` of a venue the user does not administer: the guest menu and a notice, no cabinet.
  const { context, page, errors, url } = await maxPage(browser, 390, { startParam: "manage_other-point" });
  try {
    await page.goto(url);
    await page.getByRole("status").filter({ hasText: "Управление доступно администраторам" }).waitFor({ timeout: 5_000 });
    assert.equal(new URL(page.url()).pathname, "/r/other-point");
    await page.getByLabel("Поиск по меню").waitFor();
    assert.equal(await page.getByRole("link", { name: "Редактировать" }).count(), 0, "No «Редактировать» for a non-admin");
    await settled(page);
    await page.screenshot({ path: path.join(output, "manage-denied-390.png") });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  // Restaurants list cached by the guest menu, then `/manage/<id>` of a venue missing from it while
  // the repeated GET /restaurants fails: one recheck at most, then «Не удалось открыть кабинет».
  {
    const { context, page, errors, url } = await maxPage(browser, 390, { startParam: "r_test-point" });
    let listRequests = 0;
    await context.route(/\/api\/v1\/restaurants$/, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      listRequests += 1;
      return listRequests === 1 ? route.continue() : route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Сервер недоступен" }) });
    });
    try {
      await page.goto(url);
      await page.getByLabel("Поиск по меню").waitFor({ timeout: 5_000 });
      for (let i = 0; i < 40 && !listRequests; i++) await page.waitForTimeout(50);
      assert.equal(listRequests, 1, "Guest menu caches the restaurants list");
      await page.evaluate(() => { window.history.pushState({}, "", "/manage/foreign-point"); window.dispatchEvent(new PopStateEvent("popstate")); });
      await page.getByRole("heading", { name: "Не удалось открыть кабинет" }).waitFor({ timeout: 5_000 });
      await page.getByRole("button", { name: "Повторить" }).waitFor();
      await page.waitForTimeout(1_000);
      assert.ok(listRequests <= 2, `Bounded list rechecks, got ${listRequests} GET /restaurants`);
      assert.equal(await page.getByText("Загружаем кабинет…").count(), 0);
      assert.equal(new URL(page.url()).pathname, "/manage/foreign-point");
      await page.screenshot({ path: path.join(output, "manage-recheck-error-390.png") });
      assert.deepEqual(errors.filter((error) => !/500 .*\/api\/v1\/restaurants$/.test(error)), []);
    } finally {
      await context.close();
    }
  }
}

// --- Home --------------------------------------------------------------------------

const EMPTY_HOME = { display_name: "Ира Новикова", first_name: "Ира", is_admin: false, admin_venues: [], recent: [], favorites: [] };
const venue = (publicId, name, extra = {}) => ({ id: `id-${publicId}`, public_id: publicId, name, is_creator: true, has_published_menu: true, unpublished_changes: 0, points: [{ id: `id-${publicId}`, public_id: publicId, name, address: null }], ...extra });
const ADMIN_HOME = {
  display_name: "Анна Смирнова",
  first_name: "Анна",
  is_admin: true,
  admin_venues: [venue("test-point", "Кофейня Север", { unpublished_changes: 3 }), venue("yug-point", "Пекарня Юг с очень длинным названием для проверки переноса", { is_creator: false, has_published_menu: false })],
  recent: [{ public_id: "test-point", name: "Кофейня Север", address: "Москва, Покровка, 12", last_opened_at: "2026-09-28T10:00:00Z" }],
  favorites: [{ public_id: "test-point", name: "Кофейня Север", address: "Москва, Покровка, 12", notifications_enabled: true }],
};

async function verifyHome(browser) {
  for (const width of widths) {
    for (const [name, data] of [["empty", EMPTY_HOME], ["admin", ADMIN_HOME]]) {
      const { context, page, errors, url } = await maxPage(browser, width);
      await context.route("**/api/v1/me/home", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) }));
      try {
        await page.goto(url);
        await page.getByRole("heading", { name: `Здравствуйте, ${data.first_name}` }).waitFor({ timeout: 5_000 });
        const scan = page.getByRole("button", { name: "Сканировать QR" });
        assert.equal(await scan.isEnabled(), true, "Scanner is available inside MAX");
        await page.getByRole("button", { name: "Подключить своё заведение" }).waitFor();
        if (name === "empty") {
          await page.getByRole("heading", { name: "Сканируйте QR на столе или кассе" }).waitFor();
          for (const title of ["Мои заведения", "Недавние", "Избранные"]) assert.equal(await page.getByRole("heading", { name: title }).count(), 0, `${title} hidden when empty`);
        } else {
          assert.equal(await page.getByRole("heading", { name: "Сканируйте QR на столе или кассе" }).count(), 0);
          const cards = page.locator(".home-venues > li");
          assert.equal(await cards.count(), 2, "Admin of two venues sees both cards");
          await page.getByText("Не опубликовано: 3").waitFor();
          await page.getByText("Меню не опубликовано").waitFor();
          await page.getByRole("heading", { name: "Недавние" }).waitFor();
          await page.getByRole("heading", { name: "Избранные" }).waitFor();
          await page.getByLabel("Уведомления включены").waitFor();
        }
        assert.ok(await noOverflow(page), `Home (${name}) overflows at ${width}px`);
        await touchTargetsOk(page, ".app-screen");
        await settled(page);
        await page.screenshot({ path: path.join(output, `home-${name}-${width}.png`), fullPage: true });
        if (name === "admin") {
          await page.getByRole("link", { name: "Кабинет «Кофейня Север»" }).click();
          await page.waitForURL(`${baseUrl}/manage/test-point`);
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  }

  // Motion: the entrance is recorded on video; reduced motion keeps a fade without movement.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, recordVideo: { dir: path.join(output, "video"), size: { width: 390, height: 844 } } });
    const bridge = `window.WebApp = { initData: ${JSON.stringify(initDataFor(null))}, platform: "android", ready() {}, expand() {} };`;
    await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: bridge }));
    await context.addInitScript(presetIntroSeen);
    await context.route("**/api/v1/me/home", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700)); // show the skeleton → content cross-fade
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ADMIN_HOME) });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/`);
      await page.locator(".home-skeleton").waitFor({ timeout: 5_000 });
      await page.getByRole("heading", { name: "Здравствуйте, Анна" }).waitFor({ timeout: 5_000 });
      const moving = await page.locator(".home-enter > .home-hero").evaluate((element) => getComputedStyle(element).animationName);
      assert.equal(moving, "home-rise");
      await settled(page);
      await page.waitForTimeout(300);
      const video = page.video();
      await context.close();
      fs.renameSync(await video.path(), path.join(output, "home-entrance-390.webm"));
    } finally {
      await context.close().catch(() => undefined);
    }
  }
  {
    const { context, page, url } = await maxPage(browser, 390);
    await context.route("**/api/v1/me/home", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ADMIN_HOME) }));
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(url);
      await page.getByRole("heading", { name: "Здравствуйте, Анна" }).waitFor({ timeout: 5_000 });
      assert.equal(await page.locator(".home-enter > .home-hero").evaluate((element) => getComputedStyle(element).animationName), "home-fade", "Reduced motion: no movement");
    } finally {
      await context.close();
    }
  }

  // /me/home fails: reason and «Попробовать снова», never a blank screen.
  for (const width of widths) {
    const { context, page, url } = await maxPage(browser, width);
    let calls = 0;
    await context.route("**/api/v1/me/home", (route) => {
      calls += 1;
      return calls <= 2
        ? route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"unavailable"}' })
        : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(EMPTY_HOME) });
    });
    try {
      await page.goto(url);
      await page.getByRole("heading", { name: "Главная не загрузилась" }).waitFor({ timeout: 8_000 });
      assert.ok(await noOverflow(page));
      await touchTargetsOk(page, ".app-screen");
      await settled(page);
      await page.screenshot({ path: path.join(output, `home-error-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Попробовать снова" }).click();
      await page.getByRole("heading", { name: "Сканируйте QR на столе или кассе" }).waitFor({ timeout: 5_000 });
    } finally {
      await context.close();
    }
  }

  // Scanner: a MAX deep link opens the menu; foreign text shows a hint and stays on Home.
  for (const [scanResult, expected] of [["https://max.ru/sinitsa_bot?startapp=r_test-point", "/r/test-point"], ["https://evil.example/r/test-point", "/"]]) {
    const { context, page, errors, url } = await maxPage(browser, 390, { scanResult });
    try {
      await page.goto(url);
      await page.getByRole("button", { name: "Сканировать QR" }).click();
      if (expected === "/") await page.getByRole("status").filter({ hasText: "Это не QR меню" }).waitFor({ timeout: 5_000 });
      else await page.getByLabel("Поиск по меню").waitFor({ timeout: 5_000 });
      assert.equal(new URL(page.url()).pathname, expected);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  // Opening a menu signed in records the visit; Home then lists it under «Недавние».
  {
    const { context, page, errors, url } = await maxPage(browser, 390, { startParam: "r_test-point" });
    const recent = [];
    page.on("request", (request) => { if (request.url().endsWith("/api/v1/me/recent")) recent.push(request.postData()); });
    try {
      await page.goto(url);
      await page.getByLabel("Поиск по меню").waitFor({ timeout: 5_000 });
      for (let i = 0; i < 40 && !recent.length; i++) await page.waitForTimeout(50);
      assert.deepEqual(recent.map((body) => JSON.parse(body)), [{ public_id: "test-point" }]);
      await page.goto(`${baseUrl}/home`);
      await page.getByRole("heading", { name: "Недавние" }).waitFor({ timeout: 5_000 });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  // «Подключить своё заведение»: name → new venue → its cabinet.
  {
    const { context, page, errors, url } = await maxPage(browser, 320);
    try {
      await page.goto(url);
      await page.getByRole("button", { name: "Подключить своё заведение" }).click();
      await page.waitForURL(`${baseUrl}/connect`);
      await page.getByRole("button", { name: "Создать заведение" }).click();
      await page.getByText("Укажите название").waitFor();
      assert.ok(await noOverflow(page));
      await settled(page);
      await page.screenshot({ path: path.join(output, "connect-320.png"), fullPage: true });
      await page.getByLabel("Название").fill("Чайная Восток");
      await page.getByRole("button", { name: "Создать заведение" }).click();
      await page.waitForURL(/\/manage\/[a-f0-9]{12}$/, { timeout: 5_000 });
      await page.getByRole("button", { name: "Действия с меню" }).waitFor({ timeout: 5_000 });
      await page.getByRole("button", { name: /^Заведение: Чайная Восток/ }).first().waitFor();

      // «Как начнём?» → «Шаблон кофейни»: positions without prices, the checklist, blocked publication.
      await page.getByRole("heading", { name: "Как начнём?" }).waitFor();
      await settled(page);
      assert.ok(await noOverflow(page));
      await page.screenshot({ path: path.join(output, "wizard-320.png"), fullPage: true });
      await page.getByRole("button", { name: /^Шаблон кофейни/ }).click();
      await page.getByText("Шаблон добавлен — поставьте цены").waitFor();
      await page.getByRole("button", { name: "Редактировать Капучино" }).waitFor();
      const checklist = page.locator(".menu-checklist");
      await checklist.getByText("1 из 5").waitFor();
      await checklist.getByText(/^Без цены: \d+$/).waitFor();
      await page.locator(".menu-status").filter({ hasText: "Сохранено" }).waitFor();
      await settled(page);
      await page.screenshot({ path: path.join(output, "wizard-checklist-320.png") });
      await page.getByRole("button", { name: /^Опубликовать изменения/ }).click();
      const check = page.getByRole("dialog", { name: "Что изменится" });
      await check.getByText(/^Исправьте перед публикацией · \d+$/).waitFor();
      assert.equal(await check.getByRole("button", { name: /^Опубликовать/ }).isDisabled(), true, "Unpriced template cannot be published");
      await settled(page);
      assert.ok(await noOverflow(page));
      await page.screenshot({ path: path.join(output, "publish-blocked-320.png") });
      await check.getByRole("button", { name: "Исправить" }).first().click();
      await page.getByRole("dialog", { name: "Эспрессо" }).waitFor();
      for (const width of [390, 1280]) {
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width, height: width > 1000 ? 900 : 844 });
        await settled(page);
        assert.ok(await noOverflow(page));
        await page.screenshot({ path: path.join(output, `wizard-checklist-${width}.png`) });
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

// --- Mode switching ----------------------------------------------------------------

async function verifyModeSwitch(browser) {
  for (const width of widths) {
    const { context, page, errors } = await newPage(browser, width);
    try {
      // Admin in the guest menu: «Редактировать» leads to the cabinet.
      await page.goto(`${baseUrl}/r/test-point`);
      const fab = page.getByRole("link", { name: "Редактировать" });
      await fab.waitFor({ timeout: 5_000 });
      assert.ok(await noOverflow(page));
      const box = await fab.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44 && box.x + box.width <= width, "FAB is a full touch target inside the viewport");
      await settled(page);
      await page.screenshot({ path: path.join(output, `guest-edit-${width}.png`) });

      // From an item card: straight to that item in the draft.
      await page.getByRole("button", { name: "Открыть Латте" }).click();
      const card = page.getByRole("dialog", { name: "Латте" });
      await card.waitFor();
      assert.equal(await fab.count(), 1, "One «Редактировать»: the card's own link");
      assert.ok(await noOverflow(page));
      await settled(page);
      await page.screenshot({ path: path.join(output, `guest-edit-card-${width}.png`) });
      await card.getByRole("link", { name: "Редактировать" }).click();
      await page.waitForURL((current) => current.pathname === "/manage/test-point" && current.searchParams.get("item") === "Латте");
      await page.getByRole("navigation", { name: "Настройки позиции" }).waitFor({ timeout: 5_000 });
      await page.getByRole("dialog", { name: "Латте" }).getByRole("button", { name: "Закрыть карточку" }).click();

      // Cabinet → «Посмотреть как гость» → the published menu (on phones inside «Как увидит гость»).
      if (width < 1024) await page.getByRole("button", { name: "Как увидит гость" }).click();
      const guestLink = page.getByRole("link", { name: "Посмотреть как гость" });
      await guestLink.waitFor();
      assert.ok(await noOverflow(page));
      await settled(page);
      await page.screenshot({ path: path.join(output, `cabinet-guest-link-${width}.png`) });
      await guestLink.click();
      await page.waitForURL(`${baseUrl}/r/test-point`);
      await page.getByLabel("Поиск по меню").waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  // A signed-in guest who administers nothing never sees «Редактировать».
  const { context, page, errors } = await newPage(browser, 390, (ctx) => ctx.route("**/api/v1/restaurants", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" })));
  try {
    await page.goto(`${baseUrl}/r/test-point`);
    await page.getByLabel("Поиск по меню").waitFor({ timeout: 5_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("link", { name: "Редактировать" }).count(), 0);
    await page.getByRole("button", { name: "Открыть Латте" }).click();
    await page.getByRole("dialog", { name: "Латте" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Редактировать" }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

(async () => {
  const fixture = spawn(process.execPath, [path.join(__dirname, "fixture-server.cjs")], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, FIXTURE_PORT: String(port), FIXTURE_PUBLISHED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let fixtureError = "";
  fixture.stderr.on("data", (chunk) => { fixtureError += chunk.toString(); });
  const browser = await launchChromium(chromium);
  try {
    await waitForFixture();
    await verifyStartParamRouting(browser);
    await verifyHome(browser);
    await verifyModeSwitch(browser);
    await verifyInviteScreens(browser);
    assert.equal(fixtureError, "");
    console.log("PASS: start_param routing (fragment, Bridge, late Bridge, every prefix, broken → Home), Home, mode switch and invitation at 320/390/1280px (fixture, not a real MAX client)");
  } finally {
    await browser.close();
    fixture.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
