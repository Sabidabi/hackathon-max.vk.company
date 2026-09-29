// First-launch intro «Что умеет Синица» against the built app and the in-memory
// fixture API, inside a MAX Bridge mock. Browser fixture only: it proves routing, the
// DeviceStorage contract and the screens, not a real MAX client.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const output = path.resolve(process.env.TEST_OUTPUT || "test-results");
const port = Number(process.env.INTRO_TEST_PORT || 5231);
const baseUrl = `http://127.0.0.1:${port}`;
const KEY = "sinitsa.intro.v1";
const TITLES = ["Меню кофейни прямо в MAX", "Гостю — QR, выбор, касса", "Заведению — меню за минуты"];
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

const settled = (page) => page.waitForFunction(() => document.getAnimations()
  .every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity), null, { timeout: 4_000 });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function touchTargetsOk(page) {
  const small = await page.locator(".intro").evaluate((root) =>
    Array.from(root.querySelectorAll("button, a"))
      .map((element) => ({ text: element.textContent.trim() || element.getAttribute("aria-label"), box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && (box.width < 44 || box.height < 44))
      .map(({ text, box }) => `${text} ${Math.round(box.width)}×${Math.round(box.height)}`));
  assert.deepEqual(small, [], "Touch targets under 44×44");
}

function initDataFor(startParam) {
  const fields = { auth_date: "1790330000", query_id: "fixture", user: JSON.stringify({ id: 1, first_name: "Демо" }), hash: "fixture" };
  if (startParam) fields.start_param = startParam;
  return new URLSearchParams(fields).toString();
}

/**
 * A page inside the MAX mock. `deviceStorage`: `null` — the client has no DeviceStorage (the
 * localStorage fallback decides), otherwise the initial DeviceStorage contents; writes are
 * recorded in `window.__deviceWrites`. BackButton and haptics are recorded too.
 */
async function maxContext(browser, { width = 390, height = 844, startParam = null, deviceStorage = null, video = false } = {}) {
  const initData = initDataFor(startParam);
  const storage = deviceStorage === null ? "" : `DeviceStorage: {
      getItem(key) { return Promise.resolve(window.__device[key] ?? null); },
      setItem(key, value) { window.__deviceWrites.push([key, value]); window.__device[key] = value; return Promise.resolve(true); },
      removeItem(key) { delete window.__device[key]; return Promise.resolve(true); } },`;
  const script = `window.__back = { visible: false, handlers: [] }; window.__haptics = 0; window.__deviceWrites = [];
    window.__device = Object.assign(${JSON.stringify(deviceStorage ?? {})}, window.__devicePreset || {});
    window.WebApp = { initData: ${JSON.stringify(initData)}, initDataUnsafe: { start_param: ${JSON.stringify(startParam)} }, platform: "android", version: "26.2.8",
      ready() {}, expand() {}, ${storage}
      HapticFeedback: { impactOccurred() { window.__haptics += 1; }, selectionChanged() { window.__haptics += 1; }, notificationOccurred() { window.__haptics += 1; } },
      BackButton: {
        show() { window.__back.visible = true; }, hide() { window.__back.visible = false; },
        onClick(handler) { window.__back.handlers.push(handler); },
        offClick(handler) { window.__back.handlers = window.__back.handlers.filter((item) => item !== handler); },
      } };`;
  const context = await browser.newContext({
    viewport: { width, height },
    ...(video ? { recordVideo: { dir: path.join(output, "video"), size: { width, height } } } : {}),
  });
  await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: script }));
  const errors = [];
  const chunks = [];
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { const match = /\/assets\/([A-Za-z]+Surface)-/.exec(request.url()); if (match) chunks.push(match[1]); });
  });
  const page = await context.newPage();
  return { context, page, errors, chunks };
}

const heading = (page, index) => page.getByRole("heading", { name: TITLES[index], exact: true });
const pressBack = (page) => page.evaluate(() => window.__back.handlers.forEach((handler) => handler()));
const localFlag = (page) => page.evaluate((key) => window.localStorage.getItem(key), KEY);

/** First launch at every width: the three steps are screenshotted after their autoplay. */
async function verifyLayouts(browser) {
  for (const [width, height] of [[320, 640], [390, 844], [1280, 800]]) {
    const { context, page, errors } = await maxContext(browser, { width, height });
    try {
      await page.goto(`${baseUrl}/`);
      await heading(page, 0).waitFor({ timeout: 5_000 });
      await settled(page);
      assert.ok(await noOverflow(page), `Intro overflows at ${width}px`);
      await touchTargetsOk(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1), `Intro scrolls at ${width}×${height}`);
      await page.screenshot({ path: path.join(output, `intro-1-${width}.png`) });
      await page.getByRole("button", { name: "Начать" }).click();
      await heading(page, 1).waitFor();
      await page.locator(".intro-choice--shown").waitFor({ timeout: 4_000 }); // autoplay: 350 мл → «Мой выбор»
      await settled(page);
      assert.ok(await noOverflow(page));
      await touchTargetsOk(page);
      await page.screenshot({ path: path.join(output, `intro-2-${width}.png`) });
      await page.getByRole("button", { name: "Дальше" }).click();
      await heading(page, 2).waitFor();
      await page.getByRole("status").filter({ hasText: "Круассан скрыт" }).waitFor({ timeout: 4_000 });
      await settled(page);
      assert.ok(await noOverflow(page));
      await touchTargetsOk(page);
      await page.screenshot({ path: path.join(output, `intro-3-${width}.png`) });
      // Demo and both actions fit the screen: no scrolling on the last (tallest) step.
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1), `Intro scrolls at ${width}×${height}`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

/** Very short phone (320×568): the page may scroll vertically, never sideways. */
async function verifyShortPhone(browser) {
  const { context, page, errors } = await maxContext(browser, { width: 320, height: 568 });
  try {
    await page.goto(`${baseUrl}/`);
    await heading(page, 0).waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Начать" }).click();
    await page.getByRole("button", { name: "Дальше" }).click();
    await page.getByRole("status").filter({ hasText: "Круассан скрыт" }).waitFor({ timeout: 4_000 });
    await settled(page);
    assert.ok(await noOverflow(page));
    await page.screenshot({ path: path.join(output, "intro-3-320x568.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

/** First launch → live demos → CTA; the flag lands in DeviceStorage; repeat launch → Home. */
async function verifyFirstAndRepeatLaunch(browser) {
  const { context, page, errors, chunks } = await maxContext(browser, { deviceStorage: {} });
  try {
    await page.goto(`${baseUrl}/`);
    await heading(page, 0).waitFor({ timeout: 5_000 });
    assert.equal(new URL(page.url()).pathname, "/");
    assert.equal(await page.getByRole("heading", { name: /^Здравствуйте/ }).count(), 0, "Intro comes before Home");
    await page.waitForFunction((key) => window.__deviceWrites.some(([k, v]) => k === key && v === "1"), KEY);
    assert.equal(await localFlag(page), "1", "Local copy of the flag");
    assert.ok(!chunks.includes("GuestSurface") && !chunks.includes("AdminSurface"), `Intro loads no guest/cabinet code: ${chunks}`);
    assert.equal(await page.evaluate(() => window.__back.visible), false, "No MAX «Назад» on the first step of the first launch");

    // Guest demo: the user takes over — 450 мл, «В мой выбор», the bar counts and sums.
    await page.getByRole("button", { name: "Начать" }).click();
    await heading(page, 1).waitFor();
    assert.equal(await page.evaluate(() => window.__back.visible), true, "MAX «Назад» on step 2");
    await page.locator(".intro-choice--shown").waitFor({ timeout: 4_000 });
    await page.getByRole("radio", { name: "450 мл" }).click();
    assert.equal(await page.getByRole("radio", { name: "450 мл" }).getAttribute("aria-checked"), "true");
    const haptics = await page.evaluate(() => window.__haptics);
    await page.getByRole("button", { name: /^В мой выбор/ }).click();
    await page.locator(".intro-choice__total").filter({ hasText: "490 ₽" }).waitFor(); // 230 (autoplay 350 мл) + 260
    await page.locator(".intro-choice__count").filter({ hasText: "2" }).waitFor();
    await page.waitForFunction((before) => window.__haptics >= before + 2, haptics); // impact + success
    // MAX «Назад» → previous step; then forward with the keyboard.
    await pressBack(page);
    await heading(page, 0).waitFor();
    await page.keyboard.press("ArrowRight");
    await heading(page, 1).waitFor();
    await page.getByRole("button", { name: "Дальше" }).click();
    await heading(page, 2).waitFor();

    // Owner demo: the stop-list autoplay hides the croissant; «Отменить» brings it back.
    await page.getByRole("status").filter({ hasText: "Круассан скрыт" }).waitFor({ timeout: 4_000 });
    assert.equal(await page.getByRole("switch", { name: "Круассан в наличии" }).getAttribute("aria-checked"), "false");
    await page.getByRole("button", { name: "Отменить" }).click();
    assert.equal(await page.getByRole("switch", { name: "Круассан в наличии" }).getAttribute("aria-checked"), "true");
    await page.getByRole("switch", { name: "Латте в наличии" }).click();
    await page.getByRole("status").filter({ hasText: "Латте скрыт" }).waitFor();

    // CTA → the demo menu; history back → Home (the intro is over for this launch).
    await page.getByRole("button", { name: "Посмотреть демо-меню" }).click();
    await page.waitForURL(`${baseUrl}/r/demo-sever`);
    await page.goBack();
    await page.getByRole("heading", { name: "Здравствуйте, Демо" }).waitFor({ timeout: 5_000 });
    assert.equal(await heading(page, 0).count(), 0);

    // Repeat launch: a fresh page load with the flag only in DeviceStorage → Home straight away.
    await page.evaluate((key) => window.localStorage.removeItem(key), KEY);
    await context.addInitScript((key) => { window.__devicePreset = { [key]: "1" }; }, KEY);
    await page.goto(`${baseUrl}/`);
    await page.getByRole("heading", { name: "Здравствуйте, Демо" }).waitFor({ timeout: 5_000 });
    assert.equal(await heading(page, 0).count(), 0, "Repeat launch opens Home");
    await page.screenshot({ path: path.join(output, "intro-home-entry-390.png"), fullPage: true });

    // «Что умеет Синица» on Home reopens it; «Пропустить» returns to Home.
    await page.getByRole("button", { name: "Что умеет Синица" }).click();
    await page.waitForURL(`${baseUrl}/intro`);
    await heading(page, 0).waitFor();
    assert.equal(await page.evaluate(() => window.__back.visible), true, "Replay: MAX «Назад» closes it");
    await page.getByRole("button", { name: "Пропустить" }).click();
    await page.getByRole("heading", { name: "Здравствуйте, Демо" }).waitFor({ timeout: 5_000 });
    assert.equal(new URL(page.url()).pathname, "/");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  // Repeat launch on a client without DeviceStorage: the localStorage copy decides.
  const second = await maxContext(browser);
  try {
    await second.context.addInitScript((key) => window.localStorage.setItem(key, "1"), KEY);
    await second.page.goto(`${baseUrl}/`);
    await second.page.getByRole("heading", { name: "Здравствуйте, Демо" }).waitFor({ timeout: 5_000 });
    assert.equal(await heading(second.page, 0).count(), 0);
  } finally {
    await second.context.close();
  }
}

/** A guest by QR (`startapp=r_*`) goes straight to the menu: no intro, no intro chunk, no flag. */
async function verifyStartParamSkipsIntro(browser) {
  for (const [startParam, expected] of [["r_test-point", "/r/test-point"], ["connect", "/connect"]]) {
    const { context, page, errors, chunks } = await maxContext(browser, { startParam, deviceStorage: {} });
    try {
      await page.goto(`${baseUrl}/`);
      await page.waitForURL(`${baseUrl}${expected}`, { timeout: 5_000 });
      if (expected === "/r/test-point") await page.getByLabel("Поиск по меню").waitFor({ timeout: 5_000 });
      else await page.getByRole("heading", { name: "Подключить заведение" }).waitFor({ timeout: 5_000 });
      assert.equal(await heading(page, 0).count(), 0, `No intro for startapp=${startParam}`);
      assert.ok(!chunks.includes("IntroSurface"), `Intro chunk not loaded for startapp=${startParam}: ${chunks}`);
      assert.deepEqual(await page.evaluate(() => window.__deviceWrites), [], "The intro flag is not spent by a QR launch");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

/** «Пропустить» from the first step → Home; «Подключить заведение» → /connect; swipe moves steps. */
async function verifySkipAndConnect(browser) {
  {
    const { context, page, errors } = await maxContext(browser);
    try {
      await page.goto(`${baseUrl}/`);
      await heading(page, 0).waitFor({ timeout: 5_000 });
      await page.getByRole("button", { name: "Пропустить" }).click();
      await page.getByRole("heading", { name: "Здравствуйте, Демо" }).waitFor({ timeout: 5_000 });
      assert.equal(new URL(page.url()).pathname, "/");
      assert.equal(await localFlag(page), "1");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  {
    const { context, page, errors } = await maxContext(browser, { width: 320, height: 640 });
    try {
      await page.goto(`${baseUrl}/`);
      await heading(page, 0).waitFor({ timeout: 5_000 });
      // Swipe left on the copy moves forward, right moves back.
      const swipe = async (from, to) => {
        await page.mouse.move(from, 560);
        await page.mouse.down();
        await page.mouse.move((from + to) / 2, 562);
        await page.mouse.move(to, 564);
        await page.mouse.up();
      };
      await swipe(280, 60);
      await heading(page, 1).waitFor();
      await swipe(280, 60);
      await heading(page, 2).waitFor();
      await swipe(60, 280);
      await heading(page, 1).waitFor();
      await swipe(280, 60);
      await page.getByRole("button", { name: "Подключить заведение" }).click();
      await page.waitForURL(`${baseUrl}/connect`);
      await page.getByRole("heading", { name: "Подключить заведение" }).waitFor({ timeout: 5_000 });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

/** Reduced motion: nothing plays by itself, nothing moves; the demo still works instantly. */
async function verifyReducedMotion(browser) {
  const { context, page, errors } = await maxContext(browser);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${baseUrl}/`);
    await heading(page, 0).waitFor({ timeout: 5_000 });
    // base.css clamps transitions to 0.01 ms with reduced motion: anything longer is movement.
    const moving = () => page.evaluate(() => document.getAnimations()
      .filter((animation) => animation.playState === "running" && Number(animation.effect?.getComputedTiming().duration ?? 0) > 1)
      .map((animation) => `${animation.animationName || animation.transitionProperty || "script"} on ${animation.effect?.target?.className}`));
    assert.deepEqual(await moving(), [], "No running animations on entry");
    await page.getByRole("button", { name: "Начать" }).click();
    await heading(page, 1).waitFor();
    assert.deepEqual(await moving(), [], "No running animations on a step change");
    await page.waitForTimeout(2_300);
    assert.equal(await page.locator(".intro-choice--shown").count(), 0, "No autoplay with reduced motion");
    await page.getByRole("button", { name: /^В мой выбор/ }).click();
    await page.locator(".intro-choice--shown").waitFor();
    assert.deepEqual(await moving(), [], "Adding moves nothing");
    assert.equal(await page.locator("body > .intro-card__photo").count(), 0, "No flying copy");
    assert.equal(await page.locator(".intro-choice").evaluate((element) => getComputedStyle(element).transform), "none");
    await page.screenshot({ path: path.join(output, "intro-reduced-motion-390.png") });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

/** Video of the choreography. */
async function recordVideo(browser) {
  const { context, page } = await maxContext(browser, { video: true });
  try {
    await page.goto(`${baseUrl}/`);
    await heading(page, 0).waitFor({ timeout: 5_000 });
    await page.waitForTimeout(1_400);
    await page.getByRole("button", { name: "Начать" }).click();
    await page.locator(".intro-choice--shown").waitFor({ timeout: 4_000 });
    await page.waitForTimeout(700);
    await page.getByRole("radio", { name: "450 мл" }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /^В мой выбор/ }).click();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Дальше" }).click();
    await page.getByRole("status").filter({ hasText: "Круассан скрыт" }).waitFor({ timeout: 4_000 });
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Отменить" }).click();
    await page.waitForTimeout(1_000);
    const video = page.video();
    await context.close();
    fs.renameSync(await video.path(), path.join(output, "intro-390.webm"));
  } finally {
    await context.close().catch(() => undefined);
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
    await verifyLayouts(browser);
    await verifyShortPhone(browser);
    await verifyFirstAndRepeatLaunch(browser);
    await verifyStartParamSkipsIntro(browser);
    await verifySkipAndConnect(browser);
    await verifyReducedMotion(browser);
    await recordVideo(browser);
    assert.equal(fixtureError, "");
    console.log("PASS: first-launch intro (first → intro, repeat → Home, startapp → menu without intro, skip, CTA, swipe, MAX «Назад», reduced motion) at 320/390/1280px (fixture, not a real MAX client)");
  } finally {
    await browser.close();
    fixture.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
