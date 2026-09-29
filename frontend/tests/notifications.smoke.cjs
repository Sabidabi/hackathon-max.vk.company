// «Уведомления», «Ещё → Сообщения» and the guest bot buttons against the built
// app, the in-memory fixture and route mocks for the bot API. Browser fixture only: it proves
// the screens and the requests they send, not delivery inside a real MAX client.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const output = path.resolve(process.env.TEST_OUTPUT || "test-results");
const port = Number(process.env.NOTIFICATIONS_TEST_PORT || 5207);
const baseUrl = `http://127.0.0.1:${port}`;
const widths = [320, 390, 1280];
fs.mkdirSync(output, { recursive: true });

const VENUE = "11111111-1111-4111-8111-111111111111";
const POINT = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const DIALOG = "44444444-4444-4444-8444-444444444444";
const KINDS = ["a1_import_ready", "a2_admin_joined", "a3_menu_published", "a4_draft_stale", "a5_stop_list_demand", "a6_empty_searches", "a7_weekly_summary", "a8_point_message"];

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

/** Mock of the bot endpoints; records every write. */
async function mockBotApi(context, calls, { allowed = false } = {}) {
  await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  const settings = {
    bot: { messages_allowed: allowed, allow_link: "https://max.ru/sinitsa_test_bot?start=settings", support_link: "https://max.ru/sinitsa_test_bot?start=support" },
    venues: [
      { restaurant_id: POINT, public_id: "test-point", name: "Кофейня Север", notifications_enabled: true },
      { restaurant_id: "55555555-5555-4555-8555-555555555555", public_id: "park", name: "Пекарня «Очень длинное название у парка на набережной»", notifications_enabled: false },
    ],
    items: [{ point_id: POINT, public_id: "test-point", point_name: "Кофейня Север", item_key: ITEM, item_name: "Миндальный круассан" }],
    admin: [{ venue_id: VENUE, name: "Кофейня Север", public_id: "test-point", kinds: KINDS.map((kind) => ({ kind, enabled: kind !== "a7_weekly_summary" })) }],
  };
  const now = new Date().toISOString();
  const detail = {
    id: DIALOG, number: 12, status: "open", guest_name: "Мария", last_message: "Будет ли раф к 9:00?", last_message_at: now, unread: 2, blocked: false,
    point_id: POINT, point_name: "Кофейня Север",
    messages: [
      { id: "m1", direction: "in", text: "Здравствуйте! Будет ли раф к 9:00?", photo_count: 0, created_at: now },
      { id: "m2", direction: "in", text: "", photo_count: 1, created_at: now },
    ],
  };
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (p === "/api/v1/me/notifications") return json(settings);
    if (p.startsWith("/api/v1/me/notifications/")) {
      calls.push({ method, path: p, body });
      return route.fulfill({ status: 204 });
    }
    if (p.endsWith("/chat-link")) return json({ url: "https://max.ru/sinitsa_test_bot?start=chat_test-point" });
    if (p.includes("/items/") && p.endsWith("/subscription")) {
      if (method === "PUT") { calls.push({ method, path: p, body }); return json({ subscribed: body.subscribed }); }
      return json({ subscribed: false });
    }
    if (p.endsWith("/conversations")) return json([{ ...detail, messages: undefined }]);
    if (p === `/api/v1/conversations/${DIALOG}`) return json({ ...detail, unread: 0 });
    if (p === `/api/v1/conversations/${DIALOG}/reply`) {
      calls.push({ method, path: p, body });
      return json({ ...detail, status: "answered", unread: 0, messages: [...detail.messages, { id: "m3", direction: "out", text: body.text, photo_count: 0, created_at: now }] });
    }
    return route.fallback();
  });
}

async function verifySettings(browser) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const calls = [];
    await mockBotApi(context, calls);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${baseUrl}/notifications`);
      await page.getByRole("heading", { name: "Уведомления", level: 1 }).waitFor();
      await page.getByRole("heading", { name: "Разрешите сообщения" }).waitFor();
      await page.getByRole("switch", { name: "Кофейня Север" }).waitFor();
      await page.waitForTimeout(400);
      assert.ok(await noOverflow(page), `no horizontal scroll at ${width}px`);
      await page.screenshot({ path: path.join(output, `notifications-${width}.png`), fullPage: true });
      if (width !== 390) continue;
      // Every change goes to the server at once.
      await page.getByRole("switch", { name: /Пекарня/ }).click();
      await page.getByRole("switch", { name: "Недельная сводка" }).click();
      await page.getByRole("button", { name: "Не сообщать о «Миндальный круассан»" }).click();
      await page.waitForFunction(() => document.querySelectorAll('[role="switch"][aria-checked="true"]').length >= 1);
      await expectCalls(calls, 3);
      assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
        "PUT /api/v1/me/notifications/venues/55555555-5555-4555-8555-555555555555",
        `PUT /api/v1/me/notifications/admin/${VENUE}/a7_weekly_summary`,
        `DELETE /api/v1/me/notifications/items/${POINT}/${ITEM}`,
      ]);
      assert.deepEqual(calls[0].body, { enabled: true });
      assert.deepEqual(calls[1].body, { enabled: true });
      assert.equal(await page.getByRole("switch", { name: "Недельная сводка" }).getAttribute("aria-checked"), "true");
      await page.getByRole("button", { name: "Отписаться от всего" }).click();
      await page.getByRole("button", { name: "Отписаться", exact: true }).click();
      await expectCalls(calls, 4);
      assert.equal(calls[3].path, "/api/v1/me/notifications/stop");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

async function expectCalls(calls, count) {
  for (let attempt = 0; attempt < 50 && calls.length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, count, JSON.stringify(calls));
}

async function verifyMessages(browser) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const calls = [];
    await mockBotApi(context, calls, { allowed: true });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/manage/test-point/more/messages`);
      const row = page.getByRole("button", { name: /Мария/ });
      await row.waitFor();
      assert.equal(await page.getByLabel("Непрочитанных: 2").count(), 1);
      await page.waitForTimeout(300);
      assert.ok(await noOverflow(page), `messages list fits at ${width}px`);
      await page.screenshot({ path: path.join(output, `messages-list-${width}.png`), fullPage: true });
      await row.click();
      await page.getByText("Здравствуйте! Будет ли раф к 9:00?").waitFor();
      await page.getByLabel("Ответ гостю").fill("Да, с 8:00 ждём вас");
      await page.getByRole("button", { name: "Отправить" }).click();
      await page.locator(".msg-bubble--out").waitFor();
      assert.deepEqual(calls.at(-1), { method: "POST", path: `/api/v1/conversations/${DIALOG}/reply`, body: { text: "Да, с 8:00 ждём вас" } });
      await page.waitForTimeout(300);
      assert.ok(await noOverflow(page), `dialog fits at ${width}px`);
      await page.screenshot({ path: path.join(output, `messages-dialog-${width}.png`), fullPage: true });
    } finally {
      await context.close();
    }
  }
}

async function verifyGuestButtons(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const calls = [];
  await mockBotApi(context, calls);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/r/test-point`);
    await page.getByRole("button", { name: "Написать в кофейню" }).waitFor();
    await page.getByRole("button", { name: "Американо — нет в наличии" }).click();
    const card = page.getByRole("dialog", { name: "Американо" });
    await card.waitFor();
    await card.getByRole("button", { name: "Сообщить, когда появится" }).click();
    await card.getByRole("button", { name: "Сообщим, когда появится" }).waitFor();
    assert.equal(calls.at(-1).method, "PUT");
    assert.deepEqual(calls.at(-1).body, { subscribed: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, "guest-notify-390.png") });
  } finally {
    await context.close();
  }
}

async function verifyHomeLink(browser) {
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await mockBotApi(context, []);
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/home`);
      await page.getByRole("link", { name: "Уведомления" }).waitFor();
      await page.waitForTimeout(300);
      assert.ok(await noOverflow(page), `Home fits at ${width}px`);
      await page.screenshot({ path: path.join(output, `home-${width}.png`), fullPage: true });
      await page.getByRole("link", { name: "Уведомления" }).click();
      await page.getByRole("heading", { name: "Уведомления", level: 1 }).waitFor();
      assert.equal(page.url().includes("/notifications"), true);
    } finally {
      await context.close();
    }
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
    await verifySettings(browser);
    await verifyMessages(browser);
    await verifyGuestButtons(browser);
    await verifyHomeLink(browser);
    assert.equal(fixtureError, "");
    console.log("PASS: «Уведомления», «Ещё → Сообщения», guest bot buttons, and Home link at 320/390/1280px (fixture + mocked bot API)");
  } finally {
    await browser.close();
    fixture.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
