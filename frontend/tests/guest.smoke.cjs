// Browser smoke of guest menu 2.0 on the dev preview page
// `guest-preview.html` with its own API fixture (tests/guest-fixture.cjs). Covers 320/390/1280:
// no horizontal scroll, menu tabs, sticky categories, search with a typo, the required milk,
// «Мой выбор», «Показать на кассе», 503 → «Попробовать снова», item deep links, the older
// single-menu format, «Меню ещё не опубликовано» and a MAX launch (BackButton, ♡, share,
// brightness). A browser fixture does not prove behaviour inside the real MAX client.
// Run: `BROWSER_CHANNEL=msedge node tests/guest.smoke.cjs`.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createGuestFixture } = require("./guest-fixture.cjs");

const root = path.resolve(__dirname, "..");
const output = path.resolve(process.env.TEST_OUTPUT || path.join(root, "test-results"));
const apiPort = Number(process.env.GUEST_FIXTURE_PORT || 5391);
const webPort = Number(process.env.GUEST_WEB_PORT || 5392);
const base = `http://127.0.0.1:${webPort}`;
const preview = (appPath) => `${base}/guest-preview.html?path=${encodeURIComponent(appPath)}`;
const menuApi = "/api/v1/public/restaurants/test-point/menu";

async function noHorizontalScroll(page, label) {
  const sizes = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(sizes[0] <= sizes[1] + 1, `${label}: horizontal scroll ${sizes[0]} > ${sizes[1]}`);
}

// Transitions are 140–240 ms; let them settle so screenshots show the final state.
async function shot(page, options) {
  await page.waitForTimeout(350);
  await page.screenshot(options);
}

// Sheets spring in; wait until nothing moves before touching their controls.
async function settle(page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getTiming?.().iterations === Infinity));
}

async function quoted(page, text) {
  await page.waitForFunction((expected) => document.querySelector(".quoted-price")?.textContent.replace(/\s/g, " ").includes(expected), text, { timeout: 10_000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(output, "guest-failure.png") });
    throw new Error(`Price «${text}» not shown; now «${await page.evaluate(() => document.querySelector(".quoted-price")?.textContent)}»: ${error.message}`);
  });
  return;
  await page.waitForFunction((expected) => document.querySelector(".quoted-price")?.textContent.replace(/\s/g, " ").includes(expected), text);
}

async function openMenu(page, appPath = "/r/test-point") {
  await page.goto(preview(appPath));
  await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor({ timeout: 15_000 });
}

async function scenarioAtWidth(browser, width, errors) {
  const context = await browser.newContext({ viewport: { width, height: width >= 1024 ? 900 : 780 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${width}: ${error.message}`));
  try {
    await openMenu(page);
    assert.equal(await page.getByTestId("demo-badge").count(), 0, "An ordinary venue has no «Демо» mark");
    await noHorizontalScroll(page, `menu ${width}`);
    // Tile prices never wrap («от 190» / «₽» on two lines): one line of text per price.
    const wrapped = await page.evaluate(() => [...document.querySelectorAll(".g-card--photo .g-card__price")]
      .filter((element) => element.offsetParent !== null)
      .filter((element) => element.getBoundingClientRect().height > (parseFloat(getComputedStyle(element).lineHeight) || parseFloat(getComputedStyle(element).fontSize) * 1.3) * 1.5 || element.getClientRects().length > 1)
      .map((element) => element.textContent));
    assert.deepEqual(wrapped, [], `Tile prices on one line at ${width}`);
    // cover, venue theme (not the «Синица» blue), tabs, grid, rows without photos.
    await page.getByRole("heading", { name: "Кофейня Север", level: 1 }).waitFor();
    const theme = await page.evaluate(() => ({
      root: getComputedStyle(document.querySelector(".g-root")).getPropertyValue("--sinitsa-blue").trim().toLowerCase(),
      brand: getComputedStyle(document.documentElement).getPropertyValue("--sinitsa-blue").trim().toUpperCase(),
      columns: getComputedStyle(document.querySelector(".g-grid")).gridTemplateColumns.split(" ").length,
    }));
    assert.equal(theme.root, "#1f6b57", "Menu uses the venue primary colour");
    assert.equal(theme.brand, "#2450FF", "The app palette on :root stays the brand one");
    assert.equal(theme.columns, width >= 720 ? 3 : 2, "2 cards per row on phones, 3 on wide screens");
    assert.equal(await page.locator(".g-rows .g-card--row").filter({ hasText: "Круассан" }).count(), 1, "Item without a photo is a compact row");
    await page.getByText("Меню на Синице", { exact: true }).waitFor();
    const americano = page.locator("article").filter({ hasText: "Американо" });
    await americano.getByText("Нет в наличии").waitFor();
    assert.equal(await americano.getByRole("button", { name: /Добавить/ }).count(), 0, "Unavailable item has no «+»");
    // Owner rule: photo → tile with the real <img>; no photo → list row without any picture;
    // a mixed section shows the tiles first and the rows under them (per item, not per section).
    const layout = await page.evaluate(() => [...document.querySelectorAll("[data-section-id]")].map((section) => {
      const grid = section.querySelector(".g-grid");
      const rows = section.querySelector(".g-rows");
      return {
        name: section.querySelector("h2").textContent,
        tiles: [...section.querySelectorAll(".g-card--photo")].map((card) => ({ name: card.querySelector(".g-card__name").textContent, img: Boolean(card.querySelector("img[src]")) })),
        rows: [...section.querySelectorAll(".g-card--row")].map((card) => ({ name: card.querySelector(".g-card__name").textContent, pictures: card.querySelectorAll("img, svg.g-placeholder, .g-card__media").length })),
        gridAbove: grid && rows ? grid.getBoundingClientRect().bottom <= rows.getBoundingClientRect().top : null,
      };
    }));
    const coffee = layout.find((section) => section.name === "Кофе");
    assert.deepEqual(coffee.tiles.map((tile) => tile.name), ["Латте", "Капучино"], "Items with photos are tiles");
    assert.ok(coffee.tiles.every((tile) => tile.img), "Tiles show the item photo");
    assert.deepEqual(coffee.rows.map((row) => row.name), ["Флэт уайт", "Американо"], "Items without photos (incl. unavailable) are rows");
    assert.equal(coffee.gridAbove, true, "Mixed section: tiles above rows");
    for (const section of layout) {
      assert.ok(section.rows.every((row) => row.pictures === 0), `${section.name}: rows have no stand-in pictures`);
    }
    assert.deepEqual(layout.find((section) => section.name === "Выпечка").tiles, [], "Section without photos has no tiles");
    await shot(page, { path: path.join(output, `guest-menu-${width}.png`), fullPage: true });

    // Sticky categories: the rail stays visible and jumps to «Выпечка».
    const rail = page.getByRole("navigation", { name: "Категории меню" });
    await rail.getByRole("button", { name: "Выпечка" }).click();
    await page.waitForTimeout(700);
    const position = await page.evaluate(() => ({
      heading: document.querySelector("[data-section-id] h2") && [...document.querySelectorAll(".g-section__head h2")].find((h) => h.textContent === "Выпечка").getBoundingClientRect().top,
      sticky: document.querySelector(".g-sticky").getBoundingClientRect(),
      atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2,
    }));
    assert.ok(position.sticky.top <= 1, "Category rail sticks to the top");
    // A short page cannot scroll a lower section up to the rail: then it must be at the bottom.
    assert.ok(position.heading >= position.sticky.bottom - 2 && (position.heading < position.sticky.bottom + 80 || position.atBottom), `«Выпечка» scrolled under the rail (${position.heading} vs ${position.sticky.bottom})`);
    assert.equal(await rail.getByRole("button", { name: "Выпечка" }).getAttribute("aria-pressed"), "true");
    await shot(page, { path: path.join(output, `guest-sticky-${width}.png`) });

    // Tabs of the point's menus.
    await page.getByRole("tab", { name: "Завтраки" }).click();
    await page.getByRole("button", { name: "Открыть Сырники" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Открыть Латте", exact: true }).count(), 0);
    await page.getByRole("tab", { name: "Основное" }).click();
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();

    // search with a typo, partial input via add-ons, empty result + event.
    await page.evaluate(() => {
      window.__events = [];
      window.addEventListener("sinitsa:event", (event) => window.__events.push(event.detail));
    });
    const search = page.getByLabel("Поиск по меню");
    await search.fill("капучтно");
    await page.getByRole("button", { name: "Открыть Капучино" }).waitFor();
    assert.equal(await page.locator(".g-card mark").first().textContent(), "Капучино");
    await search.fill("овсян");
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();
    await page.getByRole("button", { name: "Открыть Какао" }).waitFor();
    await search.fill("шаурма");
    await page.getByText("Ничего не нашли", { exact: true }).waitFor();
    await page.waitForFunction(() => window.__events.some((event) => event.name === "search_empty" && event.query === "шаурма"));
    await noHorizontalScroll(page, `empty search ${width}`);
    await page.getByRole("button", { name: "Очистить поиск" }).click();

    // required milk, server price, add-on counters.
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Латте" });
    await dialog.waitFor();
    await settle(page);
    await dialog.getByText("Выберите молоко", { exact: true }).waitFor();
    const addButton = dialog.getByRole("button", { name: "В мой выбор" });
    assert.equal(await addButton.isDisabled(), true, "Cannot add without the required milk");
    assert.equal(await dialog.getByLabel("Миндальное").isDisabled(), true, "Unavailable option is disabled");
    await settle(page);
    await dialog.getByLabel("Овсяное").check({ force: true });
    await quoted(page, "240 ₽");
    assert.equal(await dialog.getByText("Выберите молоко", { exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "Добавить Карамель" }).click();
    await quoted(page, "270 ₽");
    await settle(page);
    await dialog.getByLabel("350 мл").check({ force: true });
    await quoted(page, "310 ₽");
    await noHorizontalScroll(page, `item sheet ${width}`);
    // WCAG 2.5.5: touch targets of the menu and the item sheet are at least 44×44.
    const small = await page.evaluate(() => [...document.querySelectorAll(".g-card__add, .g-stepper button, .s-icon-button, .s-chip, .g-tab, .g-search__clear, .g-size, label.g-option, .g-item-footer__add")]
      .filter((element) => element.offsetParent !== null)
      .map((element) => [element.className, Math.round(element.getBoundingClientRect().width), Math.round(element.getBoundingClientRect().height)])
      .filter(([, w, h]) => w < 44 || h < 44));
    assert.deepEqual(small, [], `Touch targets ≥ 44 px at ${width}`);
    await shot(page, { path: path.join(output, `guest-item-${width}.png`) });
    await addButton.click();
    await dialog.waitFor({ state: "detached" });

    // Quick «+» for an item without choices, then «Мой выбор».
    await page.getByRole("button", { name: "Добавить Капучино в мой выбор" }).click();
    const bar = page.locator(".g-choice-bar__button");
    await bar.waitFor();
    await page.waitForFunction(() => document.querySelector(".g-choice-bar__button")?.textContent.replace(/\s/g, " ").includes("490 ₽"));
    assert.match((await bar.textContent()).replace(/\s/g, " "), /2 позиции/);
    await noHorizontalScroll(page, `choice bar ${width}`);
    await bar.click();
    const choice = page.getByRole("dialog", { name: "Мой выбор" });
    await choice.waitFor();
    await settle(page);
    await choice.getByText("350 мл, Овсяное, Карамель").waitFor();
    // Line totals come from the server: qty 2 is sent to /quote as `quantity: 2`.
    const quotedTwo = page.waitForRequest((request) => request.url().endsWith("/menu/quote") && request.method() === "POST" && request.postDataJSON()?.quantity === 2, { timeout: 10_000 });
    await choice.getByRole("button", { name: "Больше: Капучино" }).click();
    await quotedTwo;
    await page.waitForFunction(() => document.querySelector("[data-testid=choice-total]")?.textContent.replace(/\s/g, " ") === "670 ₽");
    await shot(page, { path: path.join(output, `guest-choice-${width}.png`) });

    // «Показать на кассе».
    await choice.getByRole("button", { name: "Показать на кассе" }).click();
    const cashier = page.getByRole("dialog", { name: "Мой выбор" });
    await page.locator(".g-cashier").waitFor();
    await settle(page);
    assert.equal((await page.getByTestId("cashier-total").textContent()).replace(/\s/g, " "), "670 ₽");
    await page.locator(".g-cashier").getByText("2×").waitFor();
    await noHorizontalScroll(page, `cashier ${width}`);
    await shot(page, { path: path.join(output, `guest-cashier-${width}.png`) });
    await page.getByRole("button", { name: "Закрыть сводку" }).click();
    await page.locator(".g-cashier").waitFor({ state: "detached" });
    await cashier.waitFor();
    await settle(page);
    await page.keyboard.press("Escape");
    await choice.waitFor({ state: "detached" });
  } finally {
    await context.close();
  }
}

async function scenarioDetails(browser, errors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`details: ${error.message}`));
  try {
    const snapshot = await (await context.request.get(`http://127.0.0.1:${apiPort}${menuApi}`)).json();
    const latte = snapshot.menus[0].sections[0].items.find((item) => item.name === "Латте");

    // Item deep link opens the card; closing returns to the menu address. Short hex prefix too.
    for (const linked of [latte.id, latte.id.replace(/-/g, "").slice(0, 12)]) {
      await page.goto(preview(`/r/test-point/i/${linked}`));
      await page.getByRole("dialog", { name: "Латте" }).waitFor({ timeout: 15_000 });
      await settle(page);
      await page.getByRole("button", { name: "Закрыть карточку" }).click();
      await page.waitForFunction(() => document.querySelector("[data-testid=preview-path]")?.textContent === "/r/test-point");
    }
    // Unknown item: «Позиция не найдена» and back to the menu.
    await page.goto(preview("/r/test-point/i/00000000-0000-4000-8000-000000000000"));
    await page.getByText("Позиция не найдена", { exact: true }).waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector("[data-testid=preview-path]")?.textContent === "/r/test-point");
    assert.equal(await page.getByRole("dialog").count(), 0);

    // Unavailable item card: «Нет в наличии», cannot be added.
    await page.getByRole("button", { name: "Американо — нет в наличии" }).click();
    const off = page.getByRole("dialog", { name: "Американо" });
    await off.getByText("Нет в наличии").first().waitFor();
    assert.equal(await off.getByRole("button", { name: "В мой выбор" }).isDisabled(), true);
    await page.keyboard.press("Escape");

    // «Мой выбор» survives a reload (device storage per point) and shows «Цена обновлена»
    // after a new publication (new ids, Латте dearer).
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).click();
    await settle(page);
    await page.getByRole("dialog", { name: "Латте" }).getByLabel("Обычное").check({ force: true });
    await quoted(page, "190 ₽");
    await page.getByRole("dialog", { name: "Латте" }).getByRole("button", { name: "В мой выбор" }).click();
    await page.getByRole("button", { name: "Добавить Круассан в мой выбор" }).click();
    await page.waitForFunction(() => document.querySelector(".g-choice-bar__button")?.textContent.replace(/\s/g, " ").includes("360 ₽"));
    const republished = await context.request.post(`http://127.0.0.1:${apiPort}/api/__fixture/republish`);
    assert.equal(republished.status(), 200);
    await page.reload();
    await page.locator(".g-choice-bar__button").click();
    const choice = page.getByRole("dialog", { name: "Мой выбор" });
    await choice.getByText("Цена обновлена", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector("[data-testid=choice-total]")?.textContent.replace(/\s/g, " ") === "380 ₽");
    await shot(page, { path: path.join(output, "guest-price-updated-390.png") });
    // Quantity is capped at 20.
    const more = choice.getByRole("button", { name: "Больше: Круассан" });
    for (let step = 0; step < 25 && !(await more.isDisabled()); step += 1) await more.click();
    assert.equal(await choice.getByLabel("Количество: Круассан").textContent(), "20");
    await choice.getByRole("button", { name: "Убрать: Круассан" }).click();
    await page.keyboard.press("Escape");
    await choice.waitFor({ state: "detached" });
    await page.reload();
    await page.locator(".g-choice-bar__button").click();
    assert.equal(await page.getByRole("dialog", { name: "Мой выбор" }).getByText("Цена обновлена").count(), 0, "Seen prices are remembered");
    await page.keyboard.press("Escape");

    // Outside MAX ♡ explains where favourites live.
    await page.getByRole("button", { name: "Заведение в избранное" }).click();
    await page.getByRole("dialog", { name: "Откройте в MAX" }).getByRole("link", { name: "Открыть в MAX" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Открыть в MAX" }).getAttribute("href"), "https://max.ru/test_bot?startapp=r_test-point");
    await page.keyboard.press("Escape");

    // 503 → «Попробовать снова» restores the menu without reloading the app.
    await page.route(`**${menuApi}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"Сервис временно недоступен"}' }));
    await page.reload();
    await page.getByRole("button", { name: "Попробовать снова" }).waitFor({ timeout: 15_000 });
    await page.getByText("Не удалось загрузить меню", { exact: true }).waitFor();
    await shot(page, { path: path.join(output, "guest-error-390.png") });
    await page.unroute(`**${menuApi}`);
    await page.evaluate(() => { window.__sameDocument = true; });
    await page.getByRole("button", { name: "Попробовать снова" }).click();
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__sameDocument), true, "Recovered without a page reload");

    // Skeleton while loading.
    await page.route(`**${menuApi}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue().catch(() => undefined);
    });
    await page.goto(preview("/r/test-point"));
    await page.locator(".g-root[aria-busy=true] .s-skeleton").first().waitFor();
    await shot(page, { path: path.join(output, "guest-skeleton-390.png") });
    await page.unroute(`**${menuApi}`);

    // Older API format without menus[]: one menu, no tabs, dark venue theme.
    await openMenu(page, "/r/single-point");
    assert.equal(await page.getByRole("tab").count(), 0);
    assert.equal(await page.locator(".g-card--photo").count(), 0, "Menu without photos: rows only");
    await noHorizontalScroll(page, "single-point");
    await shot(page, { path: path.join(output, "guest-no-photo-dark-390.png"), fullPage: true });
    const background = await page.evaluate(() => getComputedStyle(document.querySelector(".g-root")).backgroundColor);
    assert.equal(background, "rgb(18, 18, 18)", "Dark venue theme");
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).click();
    await settle(page);
    await page.getByRole("dialog", { name: "Латте" }).getByLabel("Овсяное").check({ force: true });
    await quoted(page, "240 ₽");
    await shot(page, { path: path.join(output, "guest-single-dark-390.png") });
    await page.keyboard.press("Escape");

    // Nothing published.
    await page.goto(preview("/r/draft-point"));
    await page.getByText("Меню ещё не опубликовано", { exact: true }).waitFor({ timeout: 15_000 });
    await page.goto(preview("/r/closed-point"));
    await page.getByText("Сейчас меню не показывается", { exact: true }).waitFor({ timeout: 15_000 });
    await page.goto(preview("/r/unknown-point"));
    await page.getByText("Меню не найдено", { exact: true }).waitFor({ timeout: 15_000 });
  } finally {
    await context.close();
  }
}

// Dark venue theme and a menu without photos at the other widths.
async function scenarioDarkWidths(browser, errors) {
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width >= 1024 ? 900 : 780 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`dark ${width}: ${error.message}`));
    try {
      await openMenu(page, "/r/single-point");
      await noHorizontalScroll(page, `dark ${width}`);
      await shot(page, { path: path.join(output, `guest-no-photo-dark-${width}.png`), fullPage: true });
    } finally {
      await context.close();
    }
  }
}

// «Синица, что взять?» on the fixture's labelled mock: chips and free text, cards
// open the position, events carry no guest text, the 429 limit and a point without AI still
// give picks. The grounding/ID filter/limits themselves are backend pytest.
async function scenarioAsk(browser, errors) {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width >= 1024 ? 900 : 780 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`ask ${width}: ${error.message}`));
    try {
      await page.addInitScript(() => {
        window.__events = [];
        window.addEventListener("sinitsa:event", (event) => window.__events.push(event.detail));
      });
      await openMenu(page);
      await page.getByRole("button", { name: "Синица, что взять?" }).click();
      const sheet = page.getByRole("dialog", { name: /Синица, что взять/ });
      await sheet.waitFor();
      await settle(page);
      await sheet.getByTestId("ask-demo").waitFor();
      await sheet.getByRole("button", { name: "Без кофеина" }).click();
      await sheet.getByRole("button", { name: "Открыть Какао" }).waitFor();
      assert.equal(await sheet.getByRole("button", { name: "Открыть Латте" }).count(), 0, "No coffee without caffeine");
      await sheet.getByText("Демо-ответ без настоящего ИИ", { exact: false }).waitFor();
      await noHorizontalScroll(page, `ask ${width}`);
      await shot(page, { path: path.join(output, `ask-${width}.png`) });
      if (width === 390) {
        const input = sheet.getByRole("textbox", { name: "Что вам хочется?" });
        await input.fill("хочу что-нибудь тёплое");
        await input.press("Enter");
        await sheet.getByRole("button", { name: "Открыть Латте" }).waitFor();
        await input.fill("лимит");
        await sheet.getByRole("button", { name: "Спросить" }).click();
        await sheet.getByTestId("ask-notice").filter({ hasText: "Лимит запросов к ИИ" }).waitFor();
        assert.ok(await sheet.getByRole("button", { name: /^Открыть / }).count() > 0, "429 still gives picks without AI");
        await shot(page, { path: path.join(output, "ask-limit-390.png") });
        await sheet.getByRole("button", { name: "Без кофеина" }).click();
        await sheet.getByRole("button", { name: "Открыть Какао" }).waitFor();
      }
      await sheet.getByRole("button", { name: "Открыть Какао" }).click();
      await page.getByRole("dialog", { name: "Какао" }).waitFor();
      const events = await page.evaluate(() => window.__events.filter((event) => event.name.startsWith("ai_")));
      assert.ok(events.some((event) => event.name === "ai_ask"), "ai_ask sent");
      assert.ok(events.some((event) => event.name === "ai_answer_click" && event.position >= 1), "ai_answer_click sent");
      assert.ok(events.every((event) => !JSON.stringify(event).includes("кофеин") && !JSON.stringify(event).includes("тёпл")), "Events carry no guest text");
    } finally {
      await context.close();
    }
  }
  // A point without AI: no free text, chips give picks without AI (dark theme, no photos).
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`ask off: ${error.message}`));
  try {
    await openMenu(page, "/r/single-point");
    await page.getByRole("button", { name: "Синица, что взять?" }).click();
    const sheet = page.getByRole("dialog", { name: /Синица, что взять/ });
    await sheet.getByText("ИИ сейчас недоступен", { exact: false }).first().waitFor();
    assert.equal(await sheet.getByRole("textbox").count(), 0, "Without AI there is no chat field");
    assert.equal(await sheet.getByTestId("ask-demo").count(), 0);
    await sheet.getByRole("button", { name: "Сладкое" }).click();
    await sheet.getByRole("button", { name: "Открыть Синнабон" }).waitFor();
    assert.equal(await sheet.getByTestId("ask-notice").count(), 0, "The status is said once, above the chips");
    await noHorizontalScroll(page, "ask off");
    await shot(page, { path: path.join(output, "ask-off-dark-390.png") });
  } finally {
    await context.close();
  }
}

// Records which motion helpers ran: elements they add to <body> and moving animations.
async function watchMotion(page) {
  await page.evaluate(() => {
    window.__motion = { added: [], moving: 0, what: [] };
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType === 1 && /\bg-(flight|morph|particle)\b/.test(node.className)) window.__motion.added.push(node.className);
    }))).observe(document.body, { childList: true });
    const count = () => {
      const moving = document.getAnimations().filter((animation) => {
        // base.css turns every transition into a 0.01 ms one under reduced motion: not movement.
        if (Number(animation.effect?.getTiming?.().duration) < 5) return false;
        const keyframes = animation.effect?.getKeyframes?.() ?? [];
        return keyframes.some((frame) => (frame.transform && frame.transform !== "none") || frame.clipPath);
      });
      window.__motion.moving += moving.length;
      moving.forEach((animation) => {
        const label = `${animation.animationName || animation.transitionProperty || "waapi"} on ${animation.effect?.target?.className}`;
        if (!window.__motion.what.includes(label)) window.__motion.what.push(label);
      });
      requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
  });
}

// key guest animations (normal motion) and their absence with reduced motion,
// plus a Playwright video of the key moments for review.
async function scenarioMotion(browser, errors) {
  const videoDir = path.join(output, "guest-video");
  fs.rmSync(videoDir, { recursive: true, force: true });
  // Video needs Playwright's ffmpeg; without it the key moments are saved as frame series.
  let context = await browser.newContext({ viewport: { width: 390, height: 844 }, recordVideo: { dir: videoDir, size: { width: 390, height: 844 } } });
  let page;
  let video = true;
  try {
    page = await context.newPage();
  } catch (error) {
    if (!/ffmpeg/i.test(String(error))) throw error;
    await context.close().catch(() => undefined);
    video = false;
    console.log("note - ffmpeg for Playwright video is not installed: saving frame series guest-motion-*.png instead");
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
  }
  const burst = async (name, frames = 4, gapMs = 80) => {
    if (video) return;
    for (let index = 0; index < frames; index += 1) {
      await page.screenshot({ path: path.join(output, `guest-motion-${name}-${index}.png`) });
      await page.waitForTimeout(gapMs);
    }
  };
  page.on("pageerror", (error) => errors.push(`motion: ${error.message}`));
  try {
    await context.request.post(`http://127.0.0.1:${apiPort}/api/__fixture/reset`);
    await page.goto(preview("/r/test-point"));
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor({ timeout: 15_000 });
    await watchMotion(page);
    await page.waitForTimeout(600);
    // Sliding category indicator.
    await page.getByRole("navigation", { name: "Категории меню" }).getByRole("button", { name: "Выпечка" }).click();
    await burst("category", 3, 60);
    await page.waitForTimeout(700);
    await page.getByRole("navigation", { name: "Категории меню" }).getByRole("button", { name: "Кофе" }).click();
    await page.waitForTimeout(700);
    // Card photo → sheet photo (shared element) with a spring.
    await page.getByRole("button", { name: "Открыть Латте", exact: true }).click();
    await burst("sheet", 5, 50);
    await page.getByRole("dialog", { name: "Латте" }).waitFor();
    await page.waitForFunction(() => window.__motion.added.some((name) => name.includes("g-morph")));
    await settle(page);
    const dialog = page.getByRole("dialog", { name: "Латте" });
    await dialog.getByLabel("Овсяное").check({ force: true });
    await quoted(page, "240 ₽");
    await dialog.getByLabel("350 мл").check({ force: true });
    await quoted(page, "280 ₽");
    await page.waitForTimeout(400);
    // Drag the header down: the sheet follows and closes.
    const header = await page.locator(".s-sheet__header").boundingBox();
    await page.mouse.move(header.x + 40, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + 40, header.y + 80, { steps: 5 });
    await page.mouse.move(header.x + 40, header.y + 220, { steps: 5 });
    await page.mouse.up();
    await dialog.waitFor({ state: "detached" });
    // Quick «+»: the thumbnail flies to «Мой выбор».
    await page.getByRole("button", { name: "Добавить Капучино в мой выбор" }).click();
    await burst("flight", 4, 60);
    await page.waitForFunction(() => window.__motion.added.some((name) => name.includes("g-flight")));
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Добавить Круассан в мой выбор" }).click();
    await page.waitForTimeout(700);
    // «Показать на кассе» opens out of its button.
    await page.locator(".g-choice-bar__button").click();
    await settle(page);
    await page.getByRole("dialog", { name: "Мой выбор" }).getByRole("button", { name: "Показать на кассе" }).click();
    await page.locator(".g-cashier").waitFor();
    await burst("cashier", 3, 70);
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Закрыть сводку" }).click();
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => window.__motion.moving) > 0, "Transform animations run with normal motion");
  } finally {
    await context.close();
  }
  if (video) {
    const file = fs.readdirSync(videoDir).find((name) => name.endsWith(".webm"));
    assert.ok(file, "Video of the key animations is recorded");
    fs.renameSync(path.join(videoDir, file), path.join(output, "guest-motion-390.webm"));
  }
  fs.rmSync(videoDir, { recursive: true, force: true });

  // Reduced motion: same results, no movement (no flights, morphs, particles or transforms).
  const reduced = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const calm = await reduced.newPage();
  calm.on("pageerror", (error) => errors.push(`reduced: ${error.message}`));
  try {
    await calm.goto(preview("/r/test-point"));
    await calm.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor({ timeout: 15_000 });
    await watchMotion(calm);
    await calm.getByRole("navigation", { name: "Категории меню" }).getByRole("button", { name: "Выпечка" }).click();
    await calm.getByRole("button", { name: "Открыть Латте", exact: true }).click();
    const dialog = calm.getByRole("dialog", { name: "Латте" });
    await dialog.waitFor();
    await dialog.getByLabel("Овсяное").check({ force: true });
    await quoted(calm, "240 ₽");
    await dialog.getByRole("button", { name: "В мой выбор" }).click();
    await calm.getByRole("button", { name: "Добавить Капучино в мой выбор" }).click();
    await calm.waitForFunction(() => document.querySelector(".g-choice-bar__button")?.textContent.replace(/\s/g, " ").includes("420 ₽"));
    await calm.locator(".g-choice-bar__button").click();
    await calm.getByRole("dialog", { name: "Мой выбор" }).getByRole("button", { name: "Показать на кассе" }).click();
    await calm.locator(".g-cashier").waitFor();
    await calm.waitForTimeout(400);
    const motion = await calm.evaluate(() => window.__motion);
    assert.deepEqual(motion.added, [], "No flights, morphs or particles with reduced motion");
    assert.equal(motion.moving, 0, `No transform or clip-path animations with reduced motion: ${motion.what.join("; ")}`);
  } finally {
    await reduced.close();
  }
}

async function scenarioInMax(browser, errors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    const back = { visible: false, handlers: [] };
    window.__back = back;
    window.__max = { shared: [], brightness: [], haptics: 0 };
    window.WebApp = {
      initData: "query_id=fixture&user=%7B%22id%22%3A7%7D&auth_date=1&hash=fixture",
      platform: "android",
      version: "26.0",
      ready() {},
      expand() {},
      BackButton: {
        show() { back.visible = true; },
        hide() { back.visible = false; },
        onClick(handler) { back.handlers.push(handler); },
        offClick(handler) { back.handlers = back.handlers.filter((candidate) => candidate !== handler); },
      },
      HapticFeedback: {
        impactOccurred() { window.__max.haptics += 1; },
        selectionChanged() { window.__max.haptics += 1; },
        notificationOccurred() { window.__max.haptics += 1; },
      },
      shareMaxContent(content) { window.__max.shared.push(content); },
      requestScreenMaxBrightness() { window.__max.brightness.push("max"); },
      restoreScreenBrightness() { window.__max.brightness.push("restore"); },
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`max: ${error.message}`));
  const pressBack = () => page.evaluate(() => window.__back.handlers.forEach((handler) => handler()));
  try {
    await openMenu(page);
    // Signed in by initData; the visit is recorded for Home «Недавние».
    await page.waitForFunction(async () => (await (await fetch("/api/__fixture/counters")).json()).recent >= 1);
    assert.equal(await page.evaluate(() => window.__back.visible), false, "No «Назад» on the menu itself");
    // Admin of this venue (shared hook from features/auth/guestMode): «Редактировать» → cabinet.
    const editFab = page.locator(".guest-edit-fab");
    await editFab.waitFor();
    assert.equal(await editFab.getAttribute("href"), "/manage/test-point");

    // BackButton closes the item card; ♡ of an item shows up in «Ваше любимое».
    await page.getByRole("button", { name: "Открыть Капучино" }).click();
    const card = page.getByRole("dialog", { name: "Капучино" });
    await card.waitFor();
    await settle(page);
    assert.equal(await page.evaluate(() => window.__back.visible), true);
    assert.equal(await card.getByRole("link", { name: "Редактировать" }).getAttribute("href"), "/manage/test-point?section=%D0%9A%D0%BE%D1%84%D0%B5&item=%D0%9A%D0%B0%D0%BF%D1%83%D1%87%D0%B8%D0%BD%D0%BE");
    await card.getByRole("button", { name: "В любимое" }).click();
    await pressBack();
    await card.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.__back.visible), false);
    await page.getByRole("heading", { name: "Ваше любимое" }).waitFor();
    await page.locator(".g-favorites").getByRole("button", { name: /Капучино/ }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Ваше любимое" }).waitFor();

    // Venue ♡ through the server; share with the r_<id> deep link.
    await page.getByRole("button", { name: "Заведение в избранное" }).click();
    await page.getByRole("button", { name: "Убрать заведение из избранного" }).waitFor();
    // Notifications only by explicit opt-in on a favourite venue.
    await page.getByRole("button", { name: "Включить уведомления" }).click();
    await page.getByRole("button", { name: "Отключить уведомления" }).waitFor();
    await page.getByRole("button", { name: "Поделиться меню" }).click();
    await page.waitForFunction(() => window.__max.shared.length === 1);
    const shared = await page.evaluate(() => window.__max.shared[0]);
    assert.equal(shared.link, "https://max.ru/test_bot?startapp=r_test-point");

    // «Показать на кассе»: brightness up, «Назад» closes the summary and then the list.
    await page.getByRole("button", { name: "Добавить Круассан в мой выбор" }).click();
    await page.locator(".g-choice-bar__button").click();
    await page.getByRole("dialog", { name: "Мой выбор" }).getByRole("button", { name: "Показать на кассе" }).click();
    await page.locator(".g-cashier").waitFor();
    await settle(page);
    await page.waitForFunction(() => window.__max.brightness.includes("max"));
    await pressBack();
    await page.locator(".g-cashier").waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__max.brightness.includes("restore"));
    await page.getByRole("dialog", { name: "Мой выбор" }).waitFor();
    await settle(page);
    await pressBack();
    await page.getByRole("dialog", { name: "Мой выбор" }).waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => [window.__back.visible, window.__back.handlers.length]), [false, 0]);
    assert.ok(await page.evaluate(() => window.__max.haptics) > 0, "Haptics on choices");
    await shot(page, { path: path.join(output, "guest-max-390.png"), fullPage: true });
  } finally {
    await context.close();
  }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const dist = path.join(root, "dist");
  if (fs.existsSync(dist)) {
    assert.equal(fs.existsSync(path.join(dist, "guest-preview.html")), false, "The dev preview must not be in the production build");
  }
  const fixture = createGuestFixture({ port: apiPort });
  await fixture.listen();
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: webPort, strictPort: true, proxy: { "/api": `http://127.0.0.1:${apiPort}` } },
  });
  await vite.listen();
  let browser;
  const errors = [];
  try {
    browser = await launchChromium(chromium);
    for (const width of [320, 390, 1280]) {
      await scenarioAtWidth(browser, width, errors);
      console.log(`ok - guest flow at ${width}px`);
    }
    await scenarioDetails(browser, errors);
    console.log("ok - deep links, price update, 503 recovery, skeleton, single-menu format, unpublished");
    await scenarioDarkWidths(browser, errors);
    console.log("ok - dark theme without photos at 320/1280px");
    await scenarioAsk(browser, errors);
    console.log("ok - «Синица, что взять?»: chips, free text, cards open the item, 429 and no-AI picks, events without text");
    await scenarioMotion(browser, errors);
    console.log("ok - motion: category slide, shared photo, drag to close, flight, cashier reveal (video); none with reduced motion");
    await scenarioInMax(browser, errors);
    console.log("ok - MAX launch: BackButton, favourites, share, brightness");
    assert.deepEqual(errors, [], "No runtime errors");
    console.log("PASS: guest menu 2.0 smoke at 320/390/1280px");
  } finally {
    await browser?.close();
    await vite.close();
    await fixture.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
