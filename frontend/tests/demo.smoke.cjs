// Regression: the link handed to a tester must work on a fresh demo launch,
// without visiting the cabinet or publishing anything first.
const { chromium } = require("playwright");
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
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
    const errors = [];
    for (const width of [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ body: "", contentType: "text/javascript" }));
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      const response = await context.request.get(`${baseUrl}${menuPath}`);
      assert.equal(response.status(), 200, "A fresh demo must already have a published menu");
      assert.ok((await response.json()).sections.length > 0);
      await page.goto(`${baseUrl}/r/test-point`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();
      assert.equal(await page.getByText("Меню пока недоступно", { exact: true }).count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal overflow at ${width}px`);
      await page.getByRole("button", { name: "Открыть Латте", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".quoted-price")?.textContent.includes("190"));
      await page.getByLabel("Овсяное").check();
      await page.waitForFunction(() => document.querySelector(".quoted-price")?.textContent.includes("240"));
      await page.getByRole("button", { name: "Готово", exact: true }).click();
      await page.reload();
      await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `demo-start-${width}.png`), fullPage: true });

      // Recovery must work without reloading the entire mini app.
      await page.route(`**${menuPath}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"Сервис временно недоступен"}' }));
      await page.reload();
      await page.getByRole("button", { name: "Обновить меню" }).waitFor();
      await page.screenshot({ path: path.join(output, `menu-recovery-${width}.png`) });
      await page.unroute(`**${menuPath}`);
      await page.getByRole("button", { name: "Обновить меню" }).click();
      await page.getByRole("button", { name: "Открыть Латте", exact: true }).waitFor();
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
