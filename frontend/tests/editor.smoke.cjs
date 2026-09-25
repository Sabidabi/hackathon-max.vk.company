// Browser contract tests against the isolated in-memory fixture server.
// This validates the built UI and HTTP contracts, not PostgreSQL or MAX.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const output = path.resolve(process.env.TEST_OUTPUT || "test-results");
const port = Number(process.env.FIXTURE_PORT || 5197);
const baseUrl = `http://127.0.0.1:${port}`;
fs.mkdirSync(output, { recursive: true });

async function waitForFixture() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture server did not start");
}

async function verifyMaxLaunch(browser, baseUrl, bridgeScript, hash = "") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const initData = new URLSearchParams({
    auth_date: "1790330000",
    user: JSON.stringify({ id: 12345, first_name: "Test" }),
    hash: "synthetic-fixture-signature",
  }).toString();
  const received = [];
  await page.route("https://st.max.ru/js/max-web-app.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: bridgeScript.replace("__INIT_DATA__", JSON.stringify(initData)) }),
  );
  await page.route("**/api/v1/auth/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/auth/me")) {
      await route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Not authenticated"}' });
    } else if (request.url().endsWith("/auth/bootstrap")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ max_auth_configured: true, development_auth: false, max_launch_url: null }) });
    } else if (request.url().endsWith("/auth/max")) {
      received.push(JSON.parse(request.postData()).init_data);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "test-user", max_user_id: 12345, display_name: "Test", username: null, language_code: "ru" }) });
    } else {
      await route.continue();
    }
  });
  try {
    const launchHash = hash === "fragment"
      ? `#WebAppData=${encodeURIComponent(initData)}&WebAppPlatform=web&WebAppVersion=26.2.8`
      : "";
    await page.goto(`${baseUrl}/${launchHash}`);
    await page.getByRole("button", { name: "Добавить позиции с ИИ" }).waitFor();
    assert.deepEqual(received, [initData], "MAX signed payload must be sent exactly once");
  } finally {
    await context.close();
  }
}

(async () => {
  const fixture = spawn(process.execPath, [path.join(__dirname, "fixture-server.cjs")], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, FIXTURE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let fixtureError = "";
  fixture.stderr.on("data", (chunk) => { fixtureError += chunk.toString(); });
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "chrome",
    headless: true,
  });

  try {
    await waitForFixture();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 500) pageErrors.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(baseUrl);
    await page.getByRole("heading", { name: /Меню/ }).waitFor();

    await page.getByRole("button", { name: "Добавить позиции с ИИ" }).click();
    await page.getByRole("heading", { name: "Добавить с ИИ" }).waitFor();
    await page.getByRole("button", { name: "Показать план" }).click();
    await page.getByText("Добавить капучино с размерами и молоком", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Добавить в черновик" }).click();
    await page.getByRole("button", { name: "Редактировать Капучино с ИИ" }).waitFor();

    await page.getByRole("button", { name: "Редактировать Латте" }).click();
    assert.equal(await page.getByLabel("Добавить фотографию блюда").count(), 1);

    await page.getByRole("button", { name: "Размеры", exact: true }).click();
    await page.getByRole("heading", { name: "Размеры 2" }).waitFor();
    assert.equal(await page.getByLabel("По умолчанию").first().isChecked(), true);

    await page.getByRole("button", { name: "Добавки", exact: true }).click();
    const milk = page.locator(".modifier-group").first();
    assert.equal(await milk.getByLabel("Название группы").inputValue(), "Молоко");
    assert.equal(await milk.getByLabel("Обязательная").isChecked(), true);
    const oat = milk.locator(".modifier-option").nth(1);
    assert.equal(await oat.getByLabel("Добавка").inputValue(), "Овсяное");
    await oat.getByLabel("Доплата, ₽").fill("60");
    await page.locator(".save-state").filter({ hasText: "Сохранено" }).waitFor();
    await page.getByRole("button", { name: "Готово", exact: true }).click();

    await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
    await page.getByText("Версия 2 опубликована", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "menu-desktop.png"), fullPage: true });

    await page.getByRole("button", { name: "Оформление", exact: true }).click();
    assert.equal(await page.locator(".site-template-swatch").count(), 4);
    await page.getByRole("button", { name: /Бистро/ }).click();
    const sitePreview = page.locator(".site-layout--preview.site-template--classic");
    await sitePreview.waitFor();
    assert.equal(
      await sitePreview.locator(".site-hero h1").evaluate((element) => getComputedStyle(element).color),
      "rgb(255, 255, 255)",
    );
    assert.equal(
      await sitePreview.locator(".menu-card-button").first().evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    await page.getByRole("button", { name: "Тёмная", exact: true }).click();
    assert.equal(
      await sitePreview.evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(14, 16, 17)",
    );
    assert.equal(
      await sitePreview.locator(".menu-card-content > strong").first().evaluate((element) => getComputedStyle(element).color),
      "rgb(244, 245, 239)",
    );
    await page.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
    await page.locator(".site-builder").getByText("Сохранено", { exact: true }).waitFor();

    await page.getByRole("button", { name: "QR-код", exact: true }).click();
    await page.locator(".menu-qr").waitFor();
    assert.equal(
      await page.locator("option[value=max]").evaluate((option) => option.disabled),
      true,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      "Admin UI has horizontal overflow at 390 px",
    );
    await page.screenshot({ path: path.join(output, "qr-mobile.png"), fullPage: true });

    await page.goto(`${baseUrl}/r/test-point`);
    await page.getByLabel("Поиск по меню").waitFor({ timeout: 1_000 });
    await page.screenshot({ path: path.join(output, "guest-catalog-mobile.png"), fullPage: true });
    assert.equal(await page.getByRole("button", { name: /Американо/ }).count(), 0);
    await page.getByLabel("В наличии").uncheck();
    const unavailable = page.getByRole("button", { name: "Американо — временно нет" });
    await unavailable.waitFor();
    assert.equal(await unavailable.isDisabled(), true);
    await page.getByLabel("В наличии").check();
    await page.getByLabel("Поиск по меню").fill("такого блюда нет");
    await page.getByText("По вашему запросу ничего не найдено.", { exact: true }).waitFor();
    await page.getByLabel("Поиск по меню").fill("");
    const categories = page.getByRole("navigation", { name: "Категории меню" });
    await categories.getByRole("button", { name: "Выпечка" }).click();
    await page.waitForTimeout(450);
    assert.ok(
      await page.getByRole("heading", { name: "Выпечка", exact: true }).evaluate((element) => element.getBoundingClientRect().top < 150),
      "Category rail did not scroll to the selected section",
    );
    const latte = page.locator("article").filter({ hasText: "Латте" });
    await latte.getByRole("button", { name: "Открыть Латте" }).click();
    assert.equal(await page.getByLabel("Обычное").isChecked(), true);
    assert.equal(await page.getByLabel("Обычное").isDisabled(), true);
    await page.getByLabel("Овсяное").check();
    await page.getByText("250 ₽", { exact: true }).waitFor();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      "Guest item dialog has horizontal overflow at 390 px",
    );
    await page.screenshot({ path: path.join(output, "guest-config-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Закрыть карточку" }).click();
    await page.getByRole("button", { name: "Добавить в избранное" }).click();
    await page.getByRole("button", { name: "Убрать из избранного" }).waitFor();
    await page.getByRole("button", { name: "Включить уведомления" }).click();
    await page.getByRole("button", { name: "Отключить уведомления" }).waitFor();

    await page.goto(baseUrl);
    await page.getByRole("button", { name: "Рассылки", exact: true }).click();
    await page.getByLabel("Заголовок", { exact: true }).fill("Новинка недели");
    await page.getByLabel("Сообщение", { exact: true }).fill("Добавили новый капучино.");
    await page.getByRole("button", { name: "Отправить · 1", exact: true }).click();
    await page.getByText("Рассылка в очереди", { exact: true }).waitFor();

    await verifyMaxLaunch(browser, baseUrl, "", "fragment");
    await verifyMaxLaunch(
      browser,
      baseUrl,
      "setTimeout(() => { window.WebApp = { initData: __INIT_DATA__, platform: 'android', ready() {}, expand() {} }; }, 150);",
    );

    assert.deepEqual(pageErrors, []);
    assert.equal(fixtureError, "");
    console.log("PASS: MAX fragment and delayed bridge login, templates, editor, modifiers, publication, QR, favorites and 390px layout (fixture API)");
  } finally {
    await browser.close();
    fixture.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
