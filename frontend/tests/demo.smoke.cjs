// Regression: the link handed to a tester must work on a fresh demo launch,
// without visiting the cabinet or publishing anything first.
const { chromium } = require("playwright");
const { launchChromium } = require("./browser.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const port = process.env.DEMO_TEST_PORT || "5298";
const baseUrl = `http://127.0.0.1:${port}`;
const menuPath = "/api/v1/public/restaurants/test-point/menu";
const output = path.resolve(process.env.TEST_OUTPUT || "test-results");

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, "demo-server.cjs")], {
    env: { ...process.env, FIXTURE_PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  let stderr = "";
  server.stderr.on("data", (data) => { stderr += data; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Demo failed to start: ${stderr}`)), 10000);
      server.once("error", (error) => { clearTimeout(timeout); reject(error); });
      server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Demo exited ${code}: ${stderr}`)); });
      server.stdout.on("data", (data) => {
        if (data.toString().includes("Visual fixture only:")) { clearTimeout(timeout); resolve(); }
      });
    });
    browser = await launchChromium(chromium);
    const errors = [];
    for (const width of [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ body: "", contentType: "text/javascript" }));
      const page = await context.newPage();
      const scripts = [];
      page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
      page.on("pageerror", (error) => errors.push(error.message));
      const response = await context.request.get(`${baseUrl}${menuPath}`);
      assert.equal(response.status(), 200, "A fresh demo must already have a published menu");
      assert.ok((await response.json()).sections.length > 0);
      await page.goto(`${baseUrl}/r/test-point`);
      await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();
      assert.equal(await page.getByText("Меню пока недоступно", { exact: true }).count(), 0);
      // P1-DOC-13 «Раздельные чанки»: the guest menu never downloads the cabinet.
      assert.ok(scripts.some((script) => /\/GuestSurface-[^/]+\.js$/.test(script)), "Guest chunk must be loaded");
      assert.deepEqual(scripts.filter((script) => /\/(AdminSurface|AccountShell|HomeSurface|LandingSurface)-/.test(script)), [], "Guest route must not load cabinet, Home or landing chunks");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal overflow at ${width}px`);
      await page.getByRole("button", { name: "Открыть Латте", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".quoted-price")?.textContent.includes("190"));
      // Guest menu 2.0: radios are visually hidden inside labelled chips.
      await page.getByRole("dialog", { name: "Латте" }).locator("label", { hasText: "Овсяное" }).click();
      await page.waitForFunction(() => document.querySelector(".quoted-price")?.textContent.includes("240"));
      await page.getByRole("button", { name: "Закрыть карточку" }).click();
      await page.locator(".guest-item-dialog").waitFor({ state: "detached" });
      await page.reload();
      await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `demo-start-${width}.png`), fullPage: true });

      // Recovery must work without reloading the entire mini app.
      await page.route(`**${menuPath}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"Сервис временно недоступен"}' }));
      await page.reload();
      await page.getByRole("button", { name: "Попробовать снова" }).waitFor();
      await page.screenshot({ path: path.join(output, `menu-recovery-${width}.png`) });
      await page.unroute(`**${menuPath}`);
      await page.getByRole("button", { name: "Попробовать снова" }).click();
      await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();

      // Item deep link (`r_<id>_i_<item>` → /r/:id/i/:item) opens the card; closing returns to the menu URL.
      const latteId = (await response.json()).sections.flatMap((section) => section.items).find((item) => item.name === "Латте").id;
      for (const linkedId of [latteId, latteId.replace(/-/g, "").slice(0, 12)]) {
        await page.goto(`${baseUrl}/r/test-point/i/${linkedId}`);
        await page.waitForFunction(() => document.querySelector(".quoted-price")?.textContent.includes("190"));
        await page.getByRole("button", { name: "Закрыть карточку" }).click();
        await page.waitForURL(`${baseUrl}/r/test-point`);
        assert.equal(await page.locator(".guest-item-dialog").count(), 0);
      }
      await context.close();
    }
    assert.deepEqual(errors, [], "No runtime errors in the guest flow");
    assert.equal(stderr, "");
    console.log("PASS: fresh demo link, modifiers, reload and error recovery at 320/390/1280px");
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
