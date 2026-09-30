// Browser smoke of the AI chat (cabinet «ИИ» tab + floating button in the menu editor) on the
// visual fixture with the labelled demo AI: pick a tool, plan → card → apply to the draft,
// stop a running request, check the menu, no horizontal scroll at 320/390/1280 px.
// A browser fixture does not prove a real model or a real MAX client.
// Run: `BROWSER_CHANNEL=msedge node tests/aichat.smoke.cjs`.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const port = process.env.AICHAT_TEST_PORT || "5299";
const base = `http://127.0.0.1:${port}`;
const output = path.resolve(process.env.TEST_OUTPUT || "test-results");

async function newPage(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 860 } });
  await context.addInitScript(() => { try { localStorage.setItem("sinitsa.intro.v1", "1"); } catch {} });
  await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ body: "", contentType: "text/javascript" }));
  await context.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "test-user", max_user_id: 1, display_name: "Демо", username: null, language_code: "ru" }) }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

async function noOverflow(page, label) {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(scroll <= inner + 1, `${label}: horizontal scroll ${scroll} > ${inner}`);
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, "fixture-server.cjs")], {
    cwd: path.resolve(__dirname, ".."), env: { ...process.env, FIXTURE_PORT: port, FIXTURE_PUBLISHED: "1" }, stdio: "ignore",
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const browser = await launchChromium(chromium);
  try {
    for (const width of [320, 390, 768, 1280]) {
      const { context, page, errors } = await newPage(browser, width);
      await page.goto(`${base}/manage/test-point/ai`);
      await page.getByRole("heading", { name: "Помощь Синицы" }).waitFor();
      // The tab is in the toolbar (bottom bar on phones, the left column on desktop).
      await page.getByRole("button", { name: "Помощь", exact: true }).first().waitFor();
      if (width < 1024) {
        const middle = page.locator(".cabinet-tabbar .s-tabbar__item").nth(2);
        assert.equal(await middle.locator('img[src="/brand/sinitsa-app-icon.svg"]').count(), 1, "The middle AI tab uses the Sinitsa mark");
      }
      for (const name of ["Оформление", "Из фото или PDF", "Поправить меню", "Проверить меню"]) {
        await page.getByRole("radio", { name: new RegExp(name) }).waitFor();
      }
      await noOverflow(page, `chat ${width}`);
      const longDraft = "Добавь позиции меню с обязательным выбором молока. ".repeat(8);
      await page.getByLabel("Сообщение для ИИ").fill(longDraft);
      const inputSize = await page.getByLabel("Сообщение для ИИ").evaluate((element) => [element.scrollHeight, element.clientHeight]);
      assert.ok(inputSize[0] <= inputSize[1] + 1, `The composer must not scroll inside itself at ${width}px`);
      await page.getByLabel("Сообщение для ИИ").fill("");

      // Design: plan → card with the demo label → apply to the draft only.
      await page.getByRole("radio", { name: /Оформление/ }).click();
      await page.getByLabel("Сообщение для ИИ").fill("Сделай тёмную тему и плитки списком, шрифт с засечками");
      await page.getByRole("button", { name: "Отправить" }).click();
      await page.getByText("Демо-ИИ", { exact: true }).waitFor();
      await page.getByText("тёмный", { exact: true }).waitFor();
      await page.getByText("список", { exact: true }).waitFor();
      await page.locator(".ai-card").first().evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
      await page.screenshot({ path: path.join(output, `aichat-plan-${width}.png`) });
      await page.getByRole("button", { name: "Применить в черновик" }).click();
      await page.getByText("Применено в черновик").waitFor();
      await page.getByText(/Гости увидят его после публикации/).waitFor();
      assert.equal(await page.getByRole("button", { name: "Применить в черновик" }).count(), 0, "A used plan cannot be applied twice");
      await noOverflow(page, `chat after apply ${width}`);

      // A design proposed in the chat must be the design shown by the editor, even when its
      // query had an older cached draft. The chat also survives the round trip.
      await page.getByLabel("Сообщение для ИИ").fill("Сделай розовый фон");
      await page.getByRole("button", { name: "Отправить" }).click();
      await page.getByLabel("Помощь Синицы").getByText("#FDE7EF").waitFor();
      await page.getByRole("button", { name: "Применить в черновик" }).click();
      await page.getByRole("button", { name: "Открыть «Оформление»" }).last().click();
      await page.getByRole("heading", { name: "Оформление", exact: true }).waitFor();
      await page.getByLabel("Цвета").getByText("#FDE7EF").waitFor();
      await noOverflow(page, `design after AI ${width}`);
      await page.getByRole("button", { name: "Помощь", exact: true }).first().click();
      await page.getByText("Сделай розовый фон").waitFor();
      assert.equal(await page.getByRole("button", { name: "Применить в черновик" }).count(), 0, "Applied plans remain applied after navigation");

      // A request that is not understood is explained, nothing is applied.
      await page.getByLabel("Сообщение для ИИ").fill("Сделай красиво");
      await page.getByRole("button", { name: "Отправить" }).click();
      await page.getByText(/Демо-ИИ не понял/).waitFor();

      // Stop a running request: the answer never arrives, the chat says so.
      await context.route("**/site/ai/plan", async (route) => { await new Promise((resolve) => setTimeout(resolve, 4000)); await route.continue().catch(() => undefined); });
      await page.getByLabel("Сообщение для ИИ").fill("Шрифт с засечками");
      await page.getByRole("button", { name: "Отправить" }).click();
      await page.getByRole("button", { name: "Остановить" }).click();
      await page.getByText("Остановила. Ничего не изменилось.").waitFor();
      assert.equal(await page.getByRole("button", { name: "Остановить" }).count(), 0);

      // Check the menu: the findings come from the code.
      await page.getByRole("radio", { name: /Проверить меню/ }).click();
      await page.getByText(/Нашла замечаний|Замечаний нет/).waitFor();
      await page.locator(".ai-card").last().evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
      await page.screenshot({ path: path.join(output, `aichat-check-${width}.png`) });
      await noOverflow(page, `chat check ${width}`);

      // The typed menu composer must return reviewable cards, and applying them changes the
      // draft menu rather than publishing them.
      await page.getByRole("radio", { name: /Поправить меню/ }).click();
      await page.getByLabel("Сообщение для ИИ").fill("Добавь капучино 300 мл 190 ₽, 400 мл 230 ₽, молоко обязательно");
      await page.getByRole("button", { name: "Отправить" }).click();
      await page.locator(".ai-plan-items strong").getByText("Капучино с ИИ").waitFor();
      await page.getByRole("button", { name: "Добавить в черновик" }).click();
      await page.getByText("Применено в черновик").last().waitFor();

      // No floating AI button any more: the chat lives in the «ИИ» tab of the toolbar.
      await page.goto(`${base}/manage/test-point/menu`);
      await page.locator(".menu-row").first().waitFor();
      await page.getByText("Капучино с ИИ").first().waitFor();
      await page.getByRole("button", { name: "Назад к точке" }).click();
      await page.getByRole("button", { name: "Меню", exact: true }).first().waitFor();
      assert.match(page.url(), /\/manage\/test-point\/point$/);
      assert.equal(await page.getByRole("button", { name: "Открыть ИИ-помощника" }).count(), 0, "No floating AI button");
      assert.deepEqual(errors, [], `page errors at ${width}`);
      await context.close();
    }
    console.log("PASS: AI chat, design sync, menu cards, navigation and responsive layout at 320/390/768/1280px (fixture)");
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((error) => { console.error(error); process.exit(1); });
