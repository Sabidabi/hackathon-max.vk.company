// Service screens of «Синица» against the built app and the in-memory fixture.
// Browser fixture only: it proves the screens and routing, not a real MAX client.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const output = path.resolve(process.env.TEST_OUTPUT || "test-results");
const port = Number(process.env.SERVICE_TEST_PORT || 5203);
const baseUrl = `http://127.0.0.1:${port}`;
const launchUrl = "https://max.ru/sinitsa_test_bot";
const widths = [320, 390, 1280];
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

/** Signed-out visitor: /auth/me is 401, bootstrap as given; counts MAX login attempts. */
async function signedOut(context, bootstrap, counters = { login: 0 }) {
  await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  await context.route("**/api/v1/auth/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/auth/me")) return route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Not authenticated"}' });
    if (url.endsWith("/auth/bootstrap")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrap) });
    if (url.endsWith("/auth/max") || url.endsWith("/auth/dev")) counters.login += 1;
    return route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Invalid data"}' });
  });
  return counters;
}

async function verifyBrandAssets(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/r/test-point`);
    assert.equal(await page.title(), "Синица");
    const icons = await page.locator("link[rel=icon]").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    assert.ok(icons.includes("/brand/sinitsa-app-icon.svg"), "SVG favicon from the brandbook");
    assert.ok(icons.includes("/brand/sinitsa-app-icon-16.png"), "16 px favicon");
    assert.equal(await page.locator("link[rel=apple-touch-icon]").getAttribute("href"), "/brand/apple-touch-icon.png");
    for (const asset of ["/brand/sinitsa-app-icon.svg", "/brand/sinitsa-lockup-blue.svg", "/brand/apple-touch-icon.png", "/manifest.webmanifest"]) {
      const response = await context.request.get(`${baseUrl}${asset}`);
      assert.equal(response.status(), 200, `${asset} is served`);
    }
    const manifest = await (await context.request.get(`${baseUrl}/manifest.webmanifest`)).json();
    assert.equal(manifest.name, "Синица");
    // Tokens are global: the body uses the brand font and canvas.
    const body = await page.evaluate(() => ({ font: getComputedStyle(document.body).fontFamily, blue: getComputedStyle(document.documentElement).getPropertyValue("--sinitsa-blue").trim() }));
    assert.match(body.font, /Arial/);
    assert.equal(body.blue.toUpperCase(), "#2450FF");
  } finally {
    await context.close();
  }
}

async function verifyOpenInMax(browser) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
    const counters = await signedOut(context, { max_auth_configured: true, development_auth: false, max_launch_url: launchUrl });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${baseUrl}/manage/test-point`);
      await page.getByRole("heading", { name: "Откройте в MAX", exact: true }).waitFor({ timeout: 5_000 });
      const deepLink = page.getByRole("link", { name: "Открыть в MAX" });
      assert.equal(await deepLink.getAttribute("href"), `${launchUrl}?startapp=manage_test-point`);
      const qr = page.getByRole("img", { name: "QR-код этой страницы" });
      await qr.waitFor();
      const box = await qr.boundingBox();
      assert.ok(box && box.width >= 150 && box.height >= 150, "QR is large enough to scan");
      assert.equal(counters.login, 0, "No login without signed MAX data");
      assert.equal(await page.locator("input").count(), 0, "No password or user-id login outside MAX");
      assert.ok(await noOverflow(page), `OpenInMax has horizontal overflow at ${width}px`);
      for (const target of [deepLink, page.getByRole("button", { name: "Скопировать ссылку" })]) {
        const size = await target.boundingBox();
        assert.ok(size.height >= 44 && size.width >= 44, "Touch target ≥ 44×44");
      }
      await page.screenshot({ path: path.join(output, `open-in-max-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Скопировать ссылку" }).click();
      await page.getByRole("status").filter({ hasText: "Ссылка скопирована" }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${launchUrl}?startapp=manage_test-point`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  // Bot not configured: an explanation instead of a dead button.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
  await signedOut(context, { max_auth_configured: false, development_auth: false, max_launch_url: null });
  const page = await context.newPage();
  try {
    // The hash may carry launch data: the copied page link (and the QR) drop it.
    await page.goto(`${baseUrl}/manage?from=qr#launch-secret`);
    await page.getByRole("heading", { name: "Откройте в MAX", exact: true }).waitFor({ timeout: 5_000 });
    assert.equal(await page.getByRole("link", { name: "Открыть в MAX" }).count(), 0);
    await page.getByText("Ссылка на бота MAX не настроена на сервере", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Скопировать ссылку" }).click();
    for (let i = 0; i < 30; i++) {
      if (await page.evaluate(() => navigator.clipboard.readText())) break;
      await page.waitForTimeout(100);
    }
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(!copied.includes("#") && !copied.includes("launch-secret"), `Copied link leaks the hash: ${copied}`);
    assert.ok(copied.startsWith(`${baseUrl}/manage`), `Copied link is the page URL: ${copied}`);
  } finally {
    await context.close();
  }
}

async function verifyAuthError(browser) {
  // With support link configured
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const initData = new URLSearchParams({ auth_date: "1790330000", user: JSON.stringify({ id: 1, first_name: "Test" }), hash: "forged" }).toString();
    await context.route("https://st.max.ru/js/max-web-app.js", (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: `window.WebApp = { initData: ${JSON.stringify(initData)}, platform: "android", ready() {}, expand() {} };` }),
    );
    let attempts = 0;
    await context.route("**/api/v1/auth/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/auth/me")) return route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Not authenticated"}' });
      if (url.endsWith("/auth/bootstrap")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ max_auth_configured: true, development_auth: false, max_launch_url: launchUrl, support_link: "https://max.ru/sinitsa_test_bot?start=support" }) });
      attempts += 1;
      return route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Invalid signature"}' });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/manage`);
      await page.getByRole("heading", { name: "Не удалось подтвердить вход", exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole("button", { name: "Перезапустить" }).waitFor();
      await page.getByRole("button", { name: "Написать в поддержку" }).waitFor({ timeout: 2_000 });
      assert.equal(attempts, 1, "Forged initData is sent once and rejected");
      assert.ok(await noOverflow(page));
      await page.screenshot({ path: path.join(output, "auth-error-390.png") });
    } finally {
      await context.close();
    }
  }

  // Without support link (bootstrap.support_link is null)
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const initData = new URLSearchParams({ auth_date: "1790330000", user: JSON.stringify({ id: 1, first_name: "Test" }), hash: "forged" }).toString();
    await context.route("https://st.max.ru/js/max-web-app.js", (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: `window.WebApp = { initData: ${JSON.stringify(initData)}, platform: "android", ready() {}, expand() {} };` }),
    );
    await context.route("**/api/v1/auth/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/auth/me")) return route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Not authenticated"}' });
      if (url.endsWith("/auth/bootstrap")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ max_auth_configured: true, development_auth: false, max_launch_url: launchUrl, support_link: null }) });
      return route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Invalid signature"}' });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/manage`);
      await page.getByRole("heading", { name: "Не удалось подтвердить вход", exact: true }).waitFor({ timeout: 5_000 });
      assert.equal(await page.getByRole("button", { name: "Написать в поддержку" }).count(), 0, "Support button not shown without support link");
    } finally {
      await context.close();
    }
  }
}

/** Login answered 502: a retryable LoadError, not AuthError; «Попробовать снова» logs in again. */
async function verifyLoginServerError(browser) {
  const context = await browser.newContext({ viewport: { width: 320, height: 844 } });
  const initData = new URLSearchParams({ auth_date: "1790330000", user: JSON.stringify({ id: 1, first_name: "Test" }), hash: "fixture" }).toString();
  await context.route("https://st.max.ru/js/max-web-app.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: `window.WebApp = { initData: ${JSON.stringify(initData)}, platform: "android", ready() {}, expand() {} };` }),
  );
  let attempts = 0;
  await context.route("**/api/v1/auth/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/auth/me")) return route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Not authenticated"}' });
    if (url.endsWith("/auth/bootstrap")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ max_auth_configured: true, development_auth: false, max_launch_url: launchUrl }) });
    attempts += 1;
    return route.fulfill({ status: 502, contentType: "text/plain", body: "Bad gateway" });
  });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/manage`);
    await page.getByRole("heading", { name: "Не удалось войти", exact: true }).waitFor({ timeout: 5_000 });
    assert.equal(await page.getByRole("heading", { name: "Не удалось подтвердить вход" }).count(), 0, "5xx is not shown as AuthError");
    assert.equal(attempts, 1);
    await page.getByRole("button", { name: "Попробовать снова" }).click();
    for (let i = 0; i < 50 && attempts < 2; i++) await page.waitForTimeout(100);
    assert.equal(attempts, 2, "Retry sends the login again");
    await page.getByRole("heading", { name: "Не удалось войти", exact: true }).waitFor({ timeout: 5_000 });
    assert.ok(await noOverflow(page));
  } finally {
    await context.close();
  }
}

async function verifyNotFound(browser) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/no-such-page`);
      await page.getByRole("heading", { name: "Страница не найдена", exact: true }).waitFor({ timeout: 5_000 });
      assert.equal(await page.getByRole("link", { name: "На главную" }).getAttribute("href"), "/");
      assert.ok(await noOverflow(page), `NotFound has horizontal overflow at ${width}px`);
      await page.screenshot({ path: path.join(output, `not-found-${width}.png`) });
      // The dev showcase is not part of the production bundle.
      await page.goto(`${baseUrl}/__ui`);
      await page.getByRole("heading", { name: "Страница не найдена", exact: true }).waitFor({ timeout: 5_000 });
    } finally {
      await context.close();
    }
  }
}

async function verifySplashTimeout(browser) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
    // The session request never answers: the splash must not spin forever.
    await context.route("**/api/v1/auth/me", () => {});
    // Provide support link for the error screen (from bootstrap)
    await context.route("**/api/v1/auth/bootstrap", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ max_auth_configured: true, development_auth: false, max_launch_url: launchUrl, support_link: "https://max.ru/sinitsa_test_bot?start=support" }) })
    );
    const page = await context.newPage();
    try {
      await page.clock.install();
      await page.goto(`${baseUrl}/manage`);
      await page.clock.fastForward(2_500); // MAX Bridge wait outside MAX
      const splash = page.locator("main.s-service--splash");
      await splash.waitFor({ timeout: 5_000 });
      assert.equal(await splash.getByRole("img", { name: "Синица" }).count(), 1, "Splash shows the «Синица» icon");
      assert.ok(await noOverflow(page));
      await page.waitForTimeout(400); // let the one-off entrance finish for the screenshot
      await page.screenshot({ path: path.join(output, `splash-${width}.png`) });
      await page.clock.fastForward(8_100);
      await page.getByRole("heading", { name: "Не удалось загрузить приложение", exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole("button", { name: "Попробовать снова" }).waitFor();
      if (width === 390) {
        await page.getByRole("button", { name: "Написать в поддержку" }).waitFor({ timeout: 2_000 });
      }
      assert.ok(await noOverflow(page), `Splash error has horizontal overflow at ${width}px`);
      await page.screenshot({ path: path.join(output, `splash-timeout-${width}.png`) });
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
    await verifyBrandAssets(browser);
    await verifyOpenInMax(browser);
    await verifyAuthError(browser);
    await verifyLoginServerError(browser);
    await verifyNotFound(browser);
    await verifySplashTimeout(browser);
    assert.equal(fixtureError, "");
    console.log("PASS: brand assets, OpenInMax, AuthError, LoadError with support button, login 5xx → LoadError, NotFound and splash timeout at 320/390/1280px (fixture)");
  } finally {
    await browser.close();
    fixture.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
