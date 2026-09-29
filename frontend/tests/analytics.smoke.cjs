// Analytics against the built app and the in-memory fixture. Browser fixture
// only: `/api/v1/events` and the report are intercepted, so this proves batching, the absence of
// personal data and the screen states — not ingestion inside a real MAX client.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const output = path.resolve(process.env.TEST_OUTPUT || "test-results");
const port = Number(process.env.ANALYTICS_TEST_PORT || 5209);
const baseUrl = `http://127.0.0.1:${port}`;
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

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

const FULL = {
  period: "7d", has_data: true, synthetic: true, demo_venue: true,
  guests: { max_users: 41, web_sessions: 187 },
  choices: 64, choice_rate: 28, avg_choice_size: 1.6,
  funnel: [
    { step: "menu_view", sessions: 228, rate: null },
    { step: "item_view", sessions: 141, rate: 62 },
    { step: "item_add", sessions: 64, rate: 45 },
    { step: "choice_shown", sessions: 29, rate: 45 },
  ],
  daily: [6, 5, 4, 3, 2, 1, 0].map((offset, index) => ({ day: day(offset), sessions: [31, 28, 40, 22, 35, 44, 28][index] })),
  top_viewed: [
    { item_key: "a", name: "Капучино", views: 58, adds: 24 },
    { item_key: "b", name: "Миндальный круассан с очень длинным названием для проверки", views: 41, adds: 12 },
    { item_key: "c", name: "Раф", views: 30, adds: 2 },
  ],
  top_chosen: [{ item_key: "a", name: "Капучино", views: 58, adds: 24 }, { item_key: "b", name: "Миндальный круассан", views: 41, adds: 12 }],
  looked_not_chosen: [{ item_key: "c", name: "Раф", views: 30, adds: 2 }],
  empty_searches: [{ query: "овсяный раф", hits: 9 }, { query: "матча", hits: 4 }],
  recommendations: { impressions: 0, clicks: 0, adds: 0 },
  d7_return: { base: 0, returned: 0, rate: null },
};
const EMPTY = {
  ...FULL, has_data: false, synthetic: false, demo_venue: false, guests: { max_users: 0, web_sessions: 0 }, choices: 0, choice_rate: null,
  avg_choice_size: null, funnel: FULL.funnel.map((step) => ({ ...step, sessions: 0, rate: step.rate === null ? null : null })),
  daily: FULL.daily.map((entry) => ({ ...entry, sessions: 0 })), top_viewed: [], top_chosen: [], looked_not_chosen: [], empty_searches: [],
};

async function guestTracking(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  const batches = [];
  let failFirst = true;
  await context.route("**/api/v1/events", async (route) => {
    // The first batch hits a network failure: the UI must not notice, the batch comes back.
    if (failFirst) {
      failFirst = false;
      return route.abort("failed");
    }
    batches.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"accepted":1,"duplicates":0}' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/r/test-point`);
    await page.waitForSelector(".g-card", { timeout: 15000 });
    await page.locator(".g-card").first().click();
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    const search = page.getByRole("searchbox").first();
    if (await search.count()) {
      await search.fill("овсяный раф");
      await page.waitForTimeout(1000);
    }
    // First flush fails (aborted), the retry lands after the next 5 s tick.
    await page.waitForTimeout(12000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    assert.ok(batches.length >= 1, "no batch arrived after the retry");
    const events = batches.flatMap((batch) => batch.events);
    const names = new Set(events.map((event) => event.name));
    for (const name of ["app_open", "menu_view", "item_view"]) assert.ok(names.has(name), `missing ${name}: ${[...names]}`);
    const ids = events.map((event) => event.client_event_id);
    assert.equal(new Set(ids).size, ids.length, "client_event_id must be unique per event");
    for (const batch of batches) {
      assert.match(batch.session_id, /^[0-9a-f-]{36}$/);
      assert.equal(batch.point, "test-point");
      assert.ok(batch.events.length <= 50);
    }
    for (const event of events) {
      for (const key of Object.keys(event.props)) assert.ok(!["name", "query", "phone", "text"].includes(key), `forbidden prop ${key}`);
      if (event.query) assert.equal(event.name, "search_empty");
    }
    const empty = events.find((event) => event.name === "search_empty");
    if (empty) assert.equal(empty.query, "овсяный раф");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

const SUMMARY_OK = {
  state: "ok", period: "7d", metrics: { guests: 228 }, provider: "openai", tips: ["Добавьте описание к Рафу."],
  text: "За неделю к вам заглянули 228 гостей, Капучино выбирали чаще всего.",
};
const SUMMARY_FEW = { state: "few_data", period: "7d", metrics: { guests: 3 }, text: null, provider: null };

async function cabinet(browser) {
  for (const [label, report, summary] of [["full", FULL, SUMMARY_OK], ["full-few", FULL, SUMMARY_FEW], ["full-error", FULL, null], ["empty", EMPTY, SUMMARY_OK]]) {
    for (const width of [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
      const requested = [];
      await context.route("**/api/v1/venues/*/analytics/ai-summary**", (route) => (
        summary ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) })
          : route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
      ));
      await context.route("**/api/v1/venues/*/analytics?**", (route) => {
        requested.push(new URL(route.request().url()).searchParams.get("period"));
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report) });
      });
      await context.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"accepted":0,"duplicates":0}' }));
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${baseUrl}/manage/test-point/analytics`);
        await page.getByRole("heading", { name: "Аналитика" }).waitFor();
        if (label.startsWith("full")) {
          await page.getByText("Воронка по сессиям").waitFor();
          if (label === "full") {
            await page.getByText("Синица подводит неделю").waitFor();
            assert.ok(await page.getByText(SUMMARY_OK.text).isVisible());
            assert.ok(await page.getByText("Добавьте описание к Рафу.").isVisible());
          } else if (label === "full-few") {
            assert.ok(await page.getByText("Сводка появится, когда наберётся данных").isVisible());
          } else {
            assert.equal(await page.getByText("Синица подводит неделю").count(), 0, "failed summary hides the block");
          }
          assert.equal(await page.getByText("демо-данные").count(), 1);
          assert.ok(await page.getByText("Искали, но не нашли").isVisible());
          assert.ok(await page.getByText("«овсяный раф»").isVisible());
          assert.ok(await page.getByText("Смотрят, но не выбирают").isVisible());
          assert.equal(await page.locator(".an-bars__col").count(), 7);
          await page.getByRole("button", { name: "30 дней" }).click();
          await page.waitForTimeout(300);
          assert.ok(requested.includes("30d"), JSON.stringify(requested));
        } else {
          await page.getByText(/Пока нет гостей — распечатайте QR|Сначала опубликуйте меню/).waitFor();
          assert.equal(await page.locator(".an-bars, .an-funnel").count(), 0, "no charts without data");
          assert.equal(await page.getByText("демо-данные").count(), 0);
        }
        assert.ok(await noOverflow(page), `horizontal overflow at ${width}px`);
        await page.screenshot({ path: path.join(output, `analytics-${label}-${width}.png`), fullPage: true });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  }
}

(async () => {
  const fixture = spawn(process.execPath, [path.join(__dirname, "fixture-server.cjs")], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, FIXTURE_PORT: String(port), FIXTURE_PUBLISHED: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let fixtureError = "";
  fixture.stderr.on("data", (chunk) => { fixtureError += chunk.toString(); });
  const browser = await launchChromium(chromium);
  try {
    await waitForFixture();
    await cabinet(browser);
    await guestTracking(browser);
    assert.equal(fixtureError, "");
    console.log("PASS: analytics tracker batches + cabinet «Аналитика» (full/empty) at 320/390/1280px (fixture + intercepted API)");
  } finally {
    await browser.close();
    fixture.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
