// Dev showcase `/__ui` (P1-TASK-6) on the Vite dev server: no horizontal scroll at
// 320/390/1280, touch targets ≥ 44×44, visible focus, reduced motion, Sheet focus handling.
// Screenshots go to test-results/. Run: `BROWSER_CHANNEL=msedge npm run test:ui`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createRequire } from "node:module";

const { launchChromium } = createRequire(import.meta.url)("./browser.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.env.TEST_OUTPUT || path.join(root, "test-results"));
fs.mkdirSync(output, { recursive: true });
const port = Number(process.env.UI_TEST_PORT || 5207);

const server = await createServer({ root, logLevel: "error", server: { port, strictPort: true, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${port}`;
const browser = await launchChromium(chromium);

try {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/__ui`);
    await page.getByRole("heading", { name: "Кнопки" }).waitFor({ timeout: 15_000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `Showcase overflows at ${width}px`);

    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".ui-showcase button, .ui-showcase a, .ui-showcase select, .ui-showcase input, .ui-showcase textarea"))
        .map((element) => ({ text: element.getAttribute("aria-label") || element.textContent.trim() || element.tagName, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && (box.width < 44 || box.height < 44))
        .map(({ text, box }) => `${text} ${Math.round(box.width)}×${Math.round(box.height)}`),
    );
    assert.deepEqual(small, [], `Touch targets under 44×44 at ${width}px`);
    await page.screenshot({ path: path.join(output, `ui-showcase-${width}.png`), fullPage: true });

    // TabBar labels: no ellipsis, no clipping (≤ 2 lines fit), font ≥ 12 px.
    const tabLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".s-tabbar__label, .s-tabbar__badge")).map((element) => ({
        text: element.textContent,
        fontSize: parseFloat(getComputedStyle(element).fontSize),
        ellipsis: getComputedStyle(element).textOverflow === "ellipsis",
        fitsWidth: element.scrollWidth <= element.clientWidth,
        fitsHeight: element.scrollHeight <= element.clientHeight + 1,
        oneWord: !/\s/.test(element.textContent.trim()),
        lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)),
      })),
    );
    for (const label of tabLabels) {
      assert.ok(label.fontSize >= 12, `Tab text «${label.text}» is ${label.fontSize}px at ${width}px`);
      assert.ok(!label.ellipsis && label.fitsWidth && label.fitsHeight, `Tab label «${label.text}» is clipped at ${width}px`);
      assert.ok(label.lines <= (label.oneWord ? 1 : 2), `Tab label «${label.text}» takes ${label.lines} lines at ${width}px`);
    }
    await page.locator(".s-tabbar").screenshot({ path: path.join(output, `ui-tabbar-${width}.png`) });

    // Squeezed bar (240 px): labels wrap to at most two lines instead of an ellipsis or clipping.
    const squeezed = await page.evaluate(() => {
      const bar = document.querySelector(".s-tabbar");
      bar.style.width = "240px";
      const result = Array.from(bar.querySelectorAll(".s-tabbar__label")).map((element) => ({
        text: element.textContent,
        fits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight + 1,
        lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)),
      }));
      bar.style.width = "";
      return result;
    });
    for (const label of squeezed) {
      assert.ok(label.fits && label.lines <= 2, `Squeezed tab label «${label.text}»: ${label.lines} lines, fits=${label.fits}`);
    }

    // Toast action «Повторить»: one line, not squeezed, still ≥ 44 px tall.
    const toastAction = await page.evaluate(() => {
      const button = document.querySelector(".s-toast .s-button");
      const label = button.querySelector(".s-button__label") || button;
      const lineHeight = parseFloat(getComputedStyle(label).lineHeight);
      return { height: button.getBoundingClientRect().height, labelHeight: label.getBoundingClientRect().height, lineHeight, fits: label.scrollWidth <= label.clientWidth };
    });
    assert.ok(toastAction.height >= 44, `Toast action is ${toastAction.height}px tall at ${width}px`);
    assert.ok(toastAction.fits && toastAction.labelHeight < toastAction.lineHeight * 1.5, `Toast action wraps at ${width}px`);
    await page.locator(".s-toast--danger").screenshot({ path: path.join(output, `ui-toast-${width}.png`) });

    // Keyboard focus is visible on the first button.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      const style = getComputedStyle(element);
      return { tag: element.tagName, ring: style.boxShadow !== "none" || style.outlineStyle !== "none" };
    });
    assert.ok(focus.ring, `Focused ${focus.tag} has no visible focus at ${width}px`);

    // Sheet: focus moves in, Tab stays inside, Escape closes and returns focus.
    const opener = page.getByRole("button", { name: "Открыть панель" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Латте" });
    await dialog.waitFor();
    assert.ok(await dialog.evaluate((element) => element.contains(document.activeElement)), "Focus moves into the sheet");
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    assert.ok(await dialog.evaluate((element) => element.contains(document.activeElement)), "Tab is trapped in the sheet");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `Sheet overflows at ${width}px`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, `ui-sheet-${width}.png`) });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await opener.evaluate((element) => element === document.activeElement), true, "Focus returns to the opener");

    // Switch semantics.
    const available = page.getByRole("switch", { name: "В наличии" });
    assert.equal(await available.getAttribute("aria-checked"), "true");
    await available.click();
    assert.equal(await available.getAttribute("aria-checked"), "false");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // prefers-reduced-motion: durations drop to 0 and the skeleton stops shimmering.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/__ui`);
  await page.getByRole("heading", { name: "Кнопки" }).waitFor({ timeout: 15_000 });
  const motion = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      fast: root.getPropertyValue("--sinitsa-duration-fast").trim(),
      tokens: ["--motion-instant", "--motion-fast", "--motion-base", "--motion-slow", "--stagger"].map((name) => root.getPropertyValue(name).trim()),
      pressScale: root.getPropertyValue("--press-scale").trim(),
      shake: root.getPropertyValue("--shake-distance").trim(),
      skeleton: getComputedStyle(document.querySelector(".s-skeleton")).animationName,
      shimmer: getComputedStyle(document.querySelector(".s-skeleton"), "::after").animationName,
    };
  });
  assert.equal(motion.fast, "0ms");
  assert.deepEqual(motion.tokens, ["0ms", "0ms", "0ms", "0ms", "0ms"], "Motion tokens drop to 0 with reduced motion");
  assert.equal(motion.pressScale, "1", "Nothing scales on press with reduced motion");
  assert.equal(motion.shake, "0px");
  assert.equal(motion.skeleton, "none");
  assert.equal(motion.shimmer, "none", "Skeleton shimmer stops with reduced motion");
  // P1-DOC-18 «Уменьшение движения»: the sheet appears with no transform animation, and a
  // FLIP/fly/roll action moves nothing but still changes the result.
  await page.getByRole("button", { name: "Открыть панель" }).click();
  const reducedSheet = page.getByRole("dialog", { name: "Латте" });
  await reducedSheet.waitFor();
  const sheetAnimations = await reducedSheet.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => {
    const frames = animation.effect?.getKeyframes?.() ?? [];
    return frames.some((frame) => frame.transform && frame.transform !== "none");
  }).length);
  assert.equal(sheetAnimations, 0, "Sheet must not move with reduced motion");
  await page.keyboard.press("Escape");
  await reducedSheet.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Добавить строку сверху" }).click();
  await page.getByText("Позиция 3", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.getAnimations().filter((animation) => {
    const frames = animation.effect?.getKeyframes?.() ?? [];
    return frames.some((frame) => frame.transform && frame.transform !== "none");
  }).length), 0, "FLIP must not move anything with reduced motion");
  await page.getByRole("button", { name: "В мой выбор" }).click();
  assert.equal(await page.locator("body > [aria-hidden=true]").count(), 0, "No flying copy with reduced motion");

  // Service screens through the showcase switch.
  for (const screen of ["open-in-max-unconfigured", "auth-error", "load-error"]) {
    await page.goto(`${baseUrl}/__ui?screen=${screen}`);
    await page.locator("main.s-service .s-service__title").waitFor(); // not the lazy-load splash
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.screenshot({ path: path.join(output, `ui-screen-${screen}-390.png`) });
  }
  await context.close();

  // Video of the reference animations (P1-DOC-18 «Проверка моушна на ревью»).
  const videoDir = path.join(output, "motion-video");
  fs.rmSync(videoDir, { recursive: true, force: true });
  const videoContext = await browser.newContext({ viewport: { width: 390, height: 844 }, recordVideo: { dir: videoDir, size: { width: 390, height: 844 } } });
  await videoContext.route("https://st.max.ru/js/max-web-app.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  const videoPage = await videoContext.newPage();
  await videoPage.goto(`${baseUrl}/__ui`);
  await videoPage.getByRole("heading", { name: "Движение" }).scrollIntoViewIfNeeded();
  await videoPage.waitForTimeout(400);
  await videoPage.getByRole("button", { name: "Опубликовать изменения: 3" }).click();
  await videoPage.waitForTimeout(1_600);
  await videoPage.getByRole("switch", { name: "Круассан — наличие" }).click();
  await videoPage.waitForTimeout(700);
  await videoPage.getByRole("button", { name: "Отменить" }).click();
  await videoPage.waitForTimeout(600);
  // The stop-list toast stays ≥ 5 s so «Отменить» can be pressed (P1-DOC-17).
  await videoPage.getByRole("switch", { name: "Круассан — наличие" }).click();
  await videoPage.getByRole("button", { name: "Отменить" }).waitFor();
  await videoPage.waitForTimeout(5_000);
  assert.equal(await videoPage.getByRole("button", { name: "Отменить" }).count(), 1, "Undo toast must stay at least 5 s");
  await videoPage.getByRole("button", { name: "Добавить строку сверху" }).click();
  await videoPage.waitForTimeout(500);
  await videoPage.getByRole("button", { name: "Проверить" }).click();
  await videoPage.waitForTimeout(600);
  await videoPage.getByRole("button", { name: "В мой выбор" }).click();
  await videoPage.waitForTimeout(700);
  await videoPage.getByRole("button", { name: /открыть карточку/ }).click();
  await videoPage.waitForTimeout(700);
  await videoPage.screenshot({ path: path.join(output, "ui-motion-sheet-390.png") });
  await videoPage.keyboard.press("Escape");
  await videoPage.waitForTimeout(500);
  await videoPage.getByRole("button", { name: "Оформление" }).click();
  await videoPage.waitForTimeout(500);
  const video = videoPage.video();
  await videoContext.close();
  const videoPath = path.join(output, "motion-showcase-390.webm");
  await video.saveAs(videoPath);
  console.log(`Motion video: ${path.relative(root, videoPath)}`);
  console.log("PASS: /__ui showcase at 320/390/1280px — no overflow, 44 px targets, focus, Sheet, reduced motion (Vite dev)");
} finally {
  await browser.close();
  await server.close();
}
