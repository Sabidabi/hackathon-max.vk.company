// End-to-end smoke against a LIVE backend: real PostgreSQL, Alembic, the demo
// seed «Кофейня Север», uvicorn with the development login and the built SPA behind
// `vite preview` with the /api proxy. Unlike the other smoke tests there is no fixture.
//
//   cd frontend && npm run build && npm run test:live
//
// The script owns its database: it DROPs and re-creates E2E_DATABASE_URL's database
// (default `sinitsa_e2e` on 127.0.0.1:55433, user postgres) — never point it at real data.
// Env: E2E_DATABASE_URL, E2E_PYTHON (backend venv python), E2E_API_PORT, E2E_WEB_PORT.
// It proves the browser ↔ API ↔ PostgreSQL contract only; it does not prove MAX itself
// (no initData, Bridge, bot or scanner) — see docs/max-production-check.md for that.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const backendDir = path.join(root, "backend");
const frontendDir = path.join(root, "frontend");
const python = process.env.E2E_PYTHON || path.join(backendDir, ".venv", "bin", "python");
const databaseUrl = process.env.E2E_DATABASE_URL || "postgresql+asyncpg://postgres@127.0.0.1:55433/sinitsa_e2e";
const apiPort = Number(process.env.E2E_API_PORT || 8765);
const webPort = Number(process.env.E2E_WEB_PORT || 4765);
const baseUrl = `http://127.0.0.1:${webPort}`;
const output = path.resolve(process.env.TEST_OUTPUT || "test-results", "live");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sinitsa-e2e-"));
const backendEnv = {
  ...process.env,
  APP_ENV: "development",
  DEV_AUTH_ENABLED: "true",
  DATABASE_URL: databaseUrl,
  DATA_ROOT: dataRoot,
  PUBLIC_APP_URL: baseUrl,
  // No real integrations: no MAX bot, no AI gateway, no MCP.
  MAX_BOT_TOKEN: "",
  MAX_BOT_USERNAME: "",
  MAX_WEBHOOK_SECRET: "",
  AI_API_KEY: "",
  AI_PROVIDER: "auto",
  MCP_ENABLED: "false",
};

function run(args, label) {
  const result = spawnSync(python, args, { cwd: backendDir, env: backendEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function resetDatabase() {
  const url = new URL(databaseUrl.replace("+asyncpg", ""));
  const name = url.pathname.slice(1);
  assert.match(name, /^[a-z0-9_]+$/, "E2E database name must be a plain identifier");
  assert.ok(!/^(menu|postgres|sinitsa_demo)$/.test(name), "Refusing to reset a non-test database");
  url.pathname = "/postgres";
  const script = `
import asyncio, asyncpg
async def main():
    connection = await asyncpg.connect(${JSON.stringify(url.toString())})
    await connection.execute('DROP DATABASE IF EXISTS "${name}" WITH (FORCE)')
    await connection.execute('CREATE DATABASE "${name}"')
    await connection.close()
asyncio.run(main())
`;
  run(["-c", script], "reset database");
}

function start(command, args, options, readyText, label) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} did not start:\n${log}`)), 30_000);
    const onData = (data) => {
      log += data;
      if (log.includes(readyText)) { clearTimeout(timeout); resolve(); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`${label} exited ${code}:\n${log}`)); });
  });
  return { child, ready, log: () => log };
}

async function api(context, method, url, data) {
  const response = await context.request.fetch(`${baseUrl}${url}`, { method, data });
  return { status: response.status(), body: response.headers()["content-type"]?.includes("json") ? await response.json() : null };
}

const allItems = (menu) => menu.menus.flatMap((entry) => entry.sections.flatMap((section) => section.items));

async function noHorizontalScroll(page, label) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal scroll: ${label}`);
}

async function quoted(page, text) {
  await page.waitForFunction((expected) => [...document.querySelectorAll(".quoted-price, [data-testid=quoted-price]")]
    .some((element) => element.textContent.replace(/\s/g, " ").includes(expected)), text, { timeout: 10_000 });
}

function watch(page, problems, label) {
  // An ordinary browser, not MAX: the Bridge script is stubbed out (no network to st.max.ru).
  page.route("https://st.max.ru/**", (route) => route.fulfill({ body: "", contentType: "text/javascript" }));
  page.on("pageerror", (error) => problems.push(`${label}: page error ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // A browser logs every non-2xx fetch; the anonymous session probe is expected to 401.
    if (/Failed to load resource: the server responded with a status of 401/.test(message.text())) return;
    problems.push(`${label}: console ${message.text()}`);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/") || response.status() < 400) return;
    if (response.status() === 401 && url.pathname === "/api/v1/auth/me") return;
    problems.push(`${label}: ${response.request().method()} ${url.pathname} → ${response.status()}`);
  });
}

async function guestFlow(browser, width, problems) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  watch(page, problems, `guest ${width}`);
  try {
    await page.goto(`${baseUrl}/r/demo-sever`);
    await page.getByRole("heading", { name: "Кофе", exact: true }).waitFor();
    await page.getByText("Север на Петровском").first().waitFor();
    await page.getByTestId("demo-badge").waitFor();
    await noHorizontalScroll(page, `guest menu ${width}`);
    await page.screenshot({ path: path.join(output, `guest-${width}.png`), fullPage: true });

    // Латте: sizes + required milk; every price comes from the server's /quote.
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).click();
    const card = page.getByRole("dialog", { name: "Латте" });
    await card.waitFor();
    await quoted(page, "190 ₽");
    assert.equal(await card.getByLabel("Обычное").isChecked(), true, "Required milk has a default");
    await card.locator("label", { hasText: "Овсяное" }).click();
    await quoted(page, "240 ₽");
    await card.locator("label", { hasText: "350 мл" }).click();
    await quoted(page, "280 ₽");
    await noHorizontalScroll(page, `item card ${width}`);
    await card.getByRole("button", { name: "В мой выбор" }).click();
    await card.waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Добавить Эспрессо в мой выбор" }).click();
    const bar = page.locator(".g-choice-bar__button");
    await page.waitForFunction(() => document.querySelector(".g-choice-bar__button")?.textContent.replace(/\s/g, " ").includes("400 ₽"));
    await bar.click();
    const choice = page.getByRole("dialog", { name: "Мой выбор" });
    await choice.getByText("350 мл, Овсяное").waitFor();
    await page.waitForFunction(() => document.querySelector("[data-testid=choice-total]")?.textContent.replace(/\s/g, " ") === "400 ₽");
    await choice.getByRole("button", { name: "Показать на кассе" }).click();
    await page.locator(".g-cashier").waitFor();
    assert.equal((await page.getByTestId("cashier-total").textContent()).replace(/\s/g, " "), "400 ₽");
    await page.waitForTimeout(400); // let the sheet animation finish before the screenshot
    await noHorizontalScroll(page, `cashier ${width}`);
    await page.screenshot({ path: path.join(output, `cashier-${width}.png`) });
    await page.getByRole("button", { name: "Закрыть сводку" }).click();
    await page.keyboard.press("Escape");

    // The other point: its own stop-list from the seed.
    await page.goto(`${baseUrl}/r/demo-sever-park`);
    await page.getByRole("button", { name: "Круассан — нет в наличии" }).waitFor();
    await page.getByTestId("demo-badge").waitFor();
    await noHorizontalScroll(page, `guest park ${width}`);
    // «Синица, что взять?» without an AI key: honest status, picks without AI from the
    // real published menu of this point — the stop-listed croissant is never offered.
    await page.getByRole("button", { name: "Синица, что взять?" }).click();
    const ask = page.getByRole("dialog", { name: /Синица, что взять/ });
    await ask.getByText("ИИ сейчас недоступен", { exact: false }).first().waitFor();
    assert.equal(await ask.getByRole("textbox").count(), 0, "No chat field without AI");
    await ask.getByRole("button", { name: "Сладкое" }).click();
    await ask.getByRole("button", { name: /^Открыть / }).first().waitFor();
    assert.equal(await ask.getByRole("button", { name: "Открыть Круассан" }).count(), 0, "Stop-list is respected");
    await page.keyboard.press("Escape");
    await ask.waitFor({ state: "detached" });

    // Landing (ordinary browser) links to the seeded demo menu.
    await page.goto(baseUrl);
    await page.getByRole("link", { name: "Открыть демо-меню" }).click();
    await page.waitForURL(`${baseUrl}/r/demo-sever`);
    await page.getByRole("heading", { name: "Кофе", exact: true }).waitFor();
    await noHorizontalScroll(page, `landing → demo ${width}`);
  } finally {
    await context.close();
  }
}

async function surfacesAt(browser, width, problems) {
  // Home and the cabinet sections render against live data without overflow.
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  watch(page, problems, `surfaces ${width}`);
  try {
    await page.goto(`${baseUrl}/home`);
    await page.getByRole("heading", { name: /^Здравствуйте/ }).waitFor();
    await page.getByText("Кофейня Север").first().waitFor();
    await noHorizontalScroll(page, `home ${width}`);
    await page.screenshot({ path: path.join(output, `home-${width}.png`), fullPage: true });
    for (const section of ["menu", "design", "more"]) {
      await page.goto(`${baseUrl}/manage/demo-sever/${section}`);
      await page.getByRole("button", { name: "Ещё", exact: true }).waitFor();
      await page.waitForLoadState("networkidle");
      await noHorizontalScroll(page, `cabinet ${section} ${width}`);
      await page.screenshot({ path: path.join(output, `cabinet-${section}-${width}.png`), fullPage: true });
    }
  } finally {
    await context.close();
  }
}

async function cabinetFlow(browser, problems) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  watch(page, problems, "cabinet");
  try {
    // `/manage` → development login → the first point's menu.
    await page.goto(`${baseUrl}/manage`);
    await page.waitForURL(/\/manage\/demo-sever\/menu$/);
    const croissant = page.getByRole("switch", { name: "Круассан: в наличии на точке «Север на Петровском»" });
    await croissant.waitFor();

    // Stop-list: applies to the point's guests at once, without publishing.
    await croissant.click();
    await page.locator("#app-toast").getByText("«Круассан» скрыт на точке «Север на Петровском»").waitFor();
    await page.waitForTimeout(500);
    let menu = await api(context, "GET", "/api/v1/public/restaurants/demo-sever/menu");
    assert.equal(allItems(menu.body).find((item) => item.name === "Круассан").is_available, false, "Stop-list reaches guests");
    assert.equal(await croissant.getAttribute("aria-checked"), "false");
    await croissant.click();
    await page.waitForFunction(async () => {
      const response = await fetch("/api/v1/public/restaurants/demo-sever/menu");
      const body = await response.json();
      return body.menus.flatMap((m) => m.sections.flatMap((s) => s.items)).find((i) => i.name === "Круассан").is_available;
    });

    // Edit: a new position through the quick line, then publish.
    const quick = page.getByLabel("Новая позиция в разделе «Кофе»: название и цена");
    await quick.fill("Раф 250");
    await quick.press("Enter");
    await page.getByRole("button", { name: "Редактировать Раф" }).waitFor();
    await page.getByText("Сохранено", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Опубликовать изменения: \d+$/ }).click();
    const summary = page.getByRole("dialog", { name: "Что изменится" });
    await summary.getByText("Раф").first().waitFor();
    await summary.getByRole("button", { name: "Опубликовать в 2 точках" }).click();
    await page.getByText(/^Опубликовано · версия \d+$/).waitFor();
    menu = await api(context, "GET", "/api/v1/public/restaurants/demo-sever/menu");
    const raf = allItems(menu.body).find((item) => item.name === "Раф");
    assert.equal(raf?.price_minor, 25000, "Published position reaches guests in kopecks");
    const park = await api(context, "GET", "/api/v1/public/restaurants/demo-sever-park/menu");
    assert.ok(allItems(park.body).some((item) => item.name === "Раф"), "The shared menu reaches the second point");

    // QR and link.
    await page.getByRole("button", { name: "Ещё", exact: true }).click();
    await page.getByRole("button", { name: /QR и ссылка/ }).click();
    await page.getByRole("img", { name: /^QR-код меню/ }).waitFor();
    assert.match(await page.getByLabel("Ссылка меню").textContent(), /\/r\/demo-sever$/);
    await page.screenshot({ path: path.join(output, "qr-390.png") });

    // New point with the shared menu.
    const stamp = Date.now().toString(36);
    await page.getByRole("button", { name: /^Точка: Север на Петровском/ }).click();
    await page.getByRole("dialog", { name: "Точки «Кофейня Север»" }).getByRole("button", { name: "Новая точка" }).click();
    const newPoint = page.getByRole("dialog", { name: "Новая точка" });
    await newPoint.getByLabel("Название").fill(`Север ${stamp}`);
    await newPoint.getByLabel("Адрес").fill("Москва, Тверская, 1");
    await newPoint.getByLabel("Часовой пояс").selectOption("Europe/Moscow");
    assert.equal(await newPoint.getByLabel("Меню точки").locator("option:checked").textContent(), "Основное", "«Основное» is the default menu of a new point");
    await newPoint.getByRole("button", { name: "Создать точку" }).click();
    await page.getByRole("button", { name: new RegExp(`^Точка: Север ${stamp}`) }).waitFor();
    const created = (await api(context, "GET", "/api/v1/restaurants")).body.find((point) => point.name === `Север ${stamp}`);
    assert.ok(created, "The new point is listed by the server");
    const createdMenu = await api(context, "GET", `/api/v1/public/restaurants/${created.public_id}/menu`);
    assert.equal(createdMenu.status, 200, "The new point shows the published menu right away");
    assert.equal(createdMenu.body.restaurant.is_demo, false, "An ordinary point is not marked as demo");
    assert.ok(allItems(createdMenu.body).some((item) => item.name === "Латте"), JSON.stringify(createdMenu.body).slice(0, 600));

    // Invite: a link, no MAX ID and no message is sent anywhere.
    await page.goto(`${baseUrl}/manage/demo-sever/more`);
    await page.getByRole("button", { name: /Администраторы/ }).click();
    await page.getByRole("button", { name: "Пригласить администратора" }).click();
    await page.getByText("Ссылка-приглашение", { exact: true }).waitFor();
    const invites = await api(context, "GET", `/api/v1/venues/${created.venue_id}/invites`);
    assert.equal(invites.status, 200, "Invites are readable by an admin");
    assert.ok(invites.body.length >= 1, "The invite is stored on the server");
    await page.screenshot({ path: path.join(output, "invite-390.png") });

    // Server authorization: an anonymous context cannot reach the cabinet API.
    const anonymous = await browser.newContext();
    const denied = await anonymous.request.get(`${baseUrl}/api/v1/restaurants`);
    assert.equal(denied.status(), 401, "Cabinet API needs a session");
    await anonymous.close();
  } catch (error) {
    await page.screenshot({ path: path.join(output, "cabinet-failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

(async () => {
  const processes = [];
  let browser;
  try {
    assert.ok(fs.existsSync(path.join(frontendDir, "dist", "index.html")), "Run `npm run build` first");
    resetDatabase();
    run(["-m", "alembic", "upgrade", "head"], "alembic upgrade head");
    const seeded = run(["-m", "app.demo_seed"], "demo seed");
    assert.match(seeded, /Кабинет \(dev-вход\): .*\/manage\/demo-sever\/menu/);
    assert.match(run(["-m", "app.demo_seed"], "demo seed (repeat)"), /Меню обновлены: нет/, "Seed is idempotent");

    const backend = start(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(apiPort)], { cwd: backendDir, env: backendEnv }, "Application startup complete", "uvicorn");
    processes.push(backend.child);
    await backend.ready;
    const vite = path.join(frontendDir, "node_modules", "vite", "bin", "vite.js");
    const web = start(process.execPath, [vite, "preview", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: frontendDir, env: { ...process.env, VITE_API_PROXY: `http://127.0.0.1:${apiPort}` } }, String(webPort), "vite preview");
    processes.push(web.child);
    await web.ready;

    browser = await launchChromium(chromium);
    const problems = [];
    for (const width of [320, 390, 1280]) await guestFlow(browser, width, problems);
    await cabinetFlow(browser, problems);
    for (const width of [320, 390, 1280]) await surfacesAt(browser, width, problems);
    assert.deepEqual(problems, [], "No console errors, page errors or failed API calls");
    console.log("PASS: live backend (PostgreSQL + seed + uvicorn + vite preview): guest, «Мой выбор»/касса, stop-list, publish, QR, new point, invite, Home at 320/390/1280px");
  } finally {
    await browser?.close();
    for (const child of processes) child.kill();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
