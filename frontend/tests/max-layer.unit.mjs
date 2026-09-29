// Unit checks for the MAX layer (src/max): start_param parser and the «never throws, always
// falls back» contract of the Bridge wrappers. Runs in Node without a browser:
// Vite bundles src/max/index.ts, the test fakes window/document/navigator per scenario.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
fs.mkdirSync(outDir, { recursive: true });

const result = await build({
  configFile: false,
  root,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    lib: { entry: path.join(root, "src/max/index.ts"), formats: ["es"], fileName: "max-layer" },
    rollupOptions: { external: ["react"] },
  },
});
const chunk = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk");
const bundlePath = path.join(outDir, "max-layer.unit.bundle.mjs");
fs.writeFileSync(bundlePath, chunk.code);

// --- Fake browser -------------------------------------------------------------------------
const events = [];
function fakeElement(tag) {
  return {
    tag, style: {}, attributes: {}, hidden: false, textContent: "", value: "",
    setAttribute(name, value) { this.attributes[name] = value; },
    // Toasts live in a region appended to <body>: register nested ids too.
    append(...children) { for (const child of children) if (child?.id) elements.set(child.id, child); },
    addEventListener() {}, remove() { events.push(`remove:${tag}`); }, select() {},
    click() { events.push(`click:${tag}:${this.download}:${this.href}`); },
  };
}
const elements = new Map();
globalThis.document = {
  body: { append(element) { if (element.id) elements.set(element.id, element); } },
  getElementById: (id) => elements.get(id) ?? null,
  createElement: fakeElement,
  execCommand: () => { events.push("execCommand:copy"); return true; },
};
const storage = new Map();
globalThis.window = {
  location: { hash: "", search: "", assign: (url) => events.push(`assign:${url}`) },
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  open: (url) => { events.push(`open:${url}`); return {}; },
  addEventListener: (name) => events.push(`add:${name}`),
  removeEventListener: (name) => events.push(`removeListener:${name}`),
  setTimeout: () => 1,
  clearTimeout: () => {},
};
let clipboard = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: async (text) => { clipboard.push(text); } } },
});

const max = await import(pathToFileURL(bundlePath).href);

// --- 1. start_param parser ------------------------------------------------------------------
const { parseStartParam, startTargetPath } = max;
assert.deepEqual(parseStartParam("r_demo-sever"), { kind: "menu", publicId: "demo-sever" });
assert.deepEqual(parseStartParam("r_0a1b2c3d4e5f_i_9f8e7d6c"), { kind: "item", publicId: "0a1b2c3d4e5f", itemId: "9f8e7d6c" });
assert.deepEqual(parseStartParam("manage_0a1b2c3d4e5f"), { kind: "manage", publicId: "0a1b2c3d4e5f" });
const token = "A".repeat(43);
assert.deepEqual(parseStartParam(`inv_${token}`), { kind: "invite", token });
assert.deepEqual(parseStartParam("connect"), { kind: "connect" });
for (const broken of [null, undefined, "", "   ", "r_", "r_demo x", "r_demo%20x", " r_demo", "r_demo ", "r_demo\n", "\tconnect", "r_демо", "inv_short", "unknown_payload", "manage_", `r_${"a".repeat(511)}`, "connect_now"]) {
  assert.equal(parseStartParam(broken), null, `must ignore ${JSON.stringify(broken)}`);
}
assert.deepEqual(parseStartParam(`r_${"a".repeat(510)}`), { kind: "menu", publicId: "a".repeat(510) }, "512 characters is still valid");
assert.equal(startTargetPath({ kind: "item", publicId: "p", itemId: "i" }), "/r/p/i/i");
assert.equal(startTargetPath({ kind: "invite", token }), `/invite/${token}`);
assert.equal(startTargetPath({ kind: "connect" }), "/connect");

// Home QR scanner: only MAX deep links, links to this app and bare payloads are followed.
const { scannedTargetPath } = max;
const origin = "https://sinitsa.example";
assert.equal(scannedTargetPath("https://max.ru/sinitsa_bot?startapp=r_sever", origin), "/r/sever");
assert.equal(scannedTargetPath("https://max.ru/sinitsa_bot?startapp=r_sever_i_0a1b2c3d", origin), "/r/sever/i/0a1b2c3d");
assert.equal(scannedTargetPath(`https://max.ru/sinitsa_bot?startapp=inv_${token}`, origin), `/invite/${token}`);
assert.equal(scannedTargetPath(`${origin}/r/sever`, origin), "/r/sever");
assert.equal(scannedTargetPath(`${origin}/r/sever/`, origin), "/r/sever");
assert.equal(scannedTargetPath(`${origin}/r/sever/i/0a1b2c3d`, origin), "/r/sever/i/0a1b2c3d");
assert.equal(scannedTargetPath("r_sever", origin), "/r/sever");
for (const foreign of [
  "https://evil.example/r/sever", "https://max.ru/sinitsa_bot", "https://max.ru/sinitsa_bot?startapp=r_sever%20x",
  `${origin}/manage/sever/../../x`, `${origin}/admin`, "javascript:alert(1)", "просто текст", "", null,
]) {
  assert.equal(scannedTargetPath(foreign, origin), null, `must ignore scanned ${JSON.stringify(foreign)}`);
}
assert.equal(startTargetPath({ kind: "manage", publicId: "p" }), "/manage/p");
assert.equal(startTargetPath({ kind: "menu", publicId: "p" }), "/r/p");

// --- 2. Outside MAX: no Bridge at all ---------------------------------------------------------
async function exerciseAll() {
  max.ready();
  max.haptics.impact("medium");
  max.haptics.selection();
  max.haptics.notify("success");
  max.closingConfirmation(true);
  max.closingConfirmation(false);
  max.openLink("https://example.com/map");
  max.openMaxLink("https://max.ru/test_bot?startapp=r_demo");
  await max.downloadFile("/api/v1/qr.png", "qr.png");
  const shared = await max.share({ text: "Меню", link: "https://example.com/r/demo" });
  const scanned = await max.scanQr();
  const brightened = await max.boostBrightness();
  await max.restoreBrightness();
  await max.deviceStorage.setItem("recent", "demo");
  const stored = await max.deviceStorage.getItem("recent");
  await max.deviceStorage.removeItem("recent");
  return { shared, scanned, brightened, stored };
}

delete window.WebApp;
let outcome = await exerciseAll();
assert.deepEqual(outcome, { shared: "copied", scanned: null, brightened: false, stored: "demo" });
assert.deepEqual(clipboard, ["https://example.com/r/demo"]);
assert.equal(elements.get("app-toast")?.textContent, "Ссылка скопирована");
assert.equal(max.canScanQr(), false);
assert.ok(events.includes("open:https://example.com/map"));
assert.ok(events.includes("click:a:qr.png:/api/v1/qr.png"));
assert.ok(events.includes("add:beforeunload"));

// --- 3. Browser with the MAX script but no launch data: Bridge must not be used ----------------
const calls = [];
const spyBridge = new Proxy({}, {
  get(_target, name) {
    if (name === "initData") return "";
    if (["BackButton", "HapticFeedback", "DeviceStorage"].includes(name)) {
      return new Proxy({}, { get: (_t, method) => () => calls.push(`${name}.${String(method)}`) });
    }
    return () => calls.push(String(name));
  },
});
window.WebApp = spyBridge;
clipboard = [];
outcome = await exerciseAll();
assert.deepEqual(calls, [], "Bridge methods must not be called outside MAX");
assert.equal(outcome.shared, "copied");

// Storage blocked (private mode) still never throws.
window.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
delete window.WebApp;
assert.equal(await max.deviceStorage.getItem("recent"), null);
await max.deviceStorage.setItem("recent", "x");
navigator.clipboard.writeText = async () => { throw new Error("denied"); };
assert.equal(await max.share({ link: "https://example.com/r/demo" }), "copied", "execCommand fallback");

// --- 4. Inside MAX with failing and succeeding Bridge methods ----------------------------------
const bridgeCalls = [];
const boom = (name) => () => { bridgeCalls.push(name); throw new Error(`${name} unsupported`); };
window.WebApp = {
  initData: "auth_date=1&hash=x",
  ready: () => bridgeCalls.push("ready"),
  shareMaxContent: boom("shareMaxContent"),
  shareContent: (content) => { bridgeCalls.push(`shareContent:${content.link}`); return Promise.reject(new Error("desktop")); },
  openCodeReader: async () => ({ value: "https://max.ru/test_bot?startapp=r_demo-sever" }),
  HapticFeedback: { impactOccurred: boom("impact"), selectionChanged: boom("selection"), notificationOccurred: boom("notify") },
  DeviceStorage: { getItem: async () => ({ value: "from-max" }), setItem: boom("DeviceStorage.setItem"), removeItem: async () => undefined },
  requestScreenMaxBrightness: async () => true,
  restoreScreenBrightness: boom("restoreScreenBrightness"),
  enableClosingConfirmation: () => bridgeCalls.push("enableClosingConfirmation"),
  disableClosingConfirmation: () => bridgeCalls.push("disableClosingConfirmation"),
  openLink: (url) => bridgeCalls.push(`openLink:${url}`),
  openMaxLink: boom("openMaxLink"),
  downloadFile: (url, name) => bridgeCalls.push(`downloadFile:${name}`),
};
window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
navigator.clipboard.writeText = async (text) => { clipboard.push(text); };
clipboard = [];
events.length = 0;
outcome = await exerciseAll();
assert.deepEqual(outcome, {
  shared: "copied",
  scanned: "https://max.ru/test_bot?startapp=r_demo-sever",
  brightened: true,
  stored: "from-max",
});
assert.equal(max.canScanQr(), true);
assert.ok(bridgeCalls.includes("ready"));
assert.ok(bridgeCalls.includes("shareMaxContent") && bridgeCalls.includes("shareContent:https://example.com/r/demo"), "share tries MAX, then system sheet");
assert.deepEqual(clipboard, ["https://example.com/r/demo"], "share falls back to copying");
assert.ok(bridgeCalls.includes("enableClosingConfirmation") && bridgeCalls.includes("disableClosingConfirmation"));
assert.ok(bridgeCalls.includes("openLink:https://example.com/map"));
assert.ok(events.includes("open:https://max.ru/test_bot?startapp=r_demo"), "openMaxLink falls back to a new tab");
assert.ok(bridgeCalls.includes("downloadFile:qr.png"));
max.ready();
assert.equal(bridgeCalls.filter((call) => call === "ready").length, 1, "ready() is sent once");

// --- BackButton stack: screen with an item card, then a Sheet on top ----------
{
  const log = [];
  let listeners = [];
  window.WebApp = {
    initData: "query_id=fixture&auth_date=1",
    BackButton: {
      isVisible: false,
      show() { this.isVisible = true; log.push("show"); },
      hide() { this.isVisible = false; log.push("hide"); },
      onClick(handler) { listeners.push(handler); log.push("onClick"); },
      offClick(handler) { listeners = listeners.filter((item) => item !== handler); log.push("offClick"); },
    },
  };
  const back = window.WebApp.BackButton;
  const tap = () => listeners.forEach((handler) => handler());
  const calls = [];
  const popCard = max.pushBackHandler(() => calls.push("card"));
  assert.equal(back.isVisible, true, "back button shows for the item card");
  const popSheet = max.pushBackHandler(() => calls.push("sheet"));
  assert.equal(listeners.length, 1, "the Bridge gets one listener for the whole stack");
  tap();
  assert.deepEqual(calls, ["sheet"], "only the top layer (Sheet) handles «Назад»");
  popSheet();
  assert.equal(back.isVisible, true, "closing the Sheet keeps the card's back button visible");
  assert.ok(!log.includes("hide"), "hide() is not called while the stack is not empty");
  tap();
  assert.deepEqual(calls, ["sheet", "card"], "after the Sheet closes the card handles «Назад»");
  popSheet();
  assert.equal(back.isVisible, true, "a repeated pop is a no-op");
  popCard();
  assert.equal(back.isVisible, false, "the button hides when the stack empties");
  assert.equal(listeners.length, 0, "the listener is removed with the last layer");
  tap();
  assert.deepEqual(calls, ["sheet", "card"]);

  // Out-of-order close: the lower layer leaves first, the top one keeps the button.
  const popA = max.pushBackHandler(() => calls.push("a"));
  const popB = max.pushBackHandler(() => calls.push("b"));
  popA();
  assert.equal(back.isVisible, true);
  tap();
  assert.deepEqual(calls.slice(-1), ["b"]);
  popB();
  assert.equal(back.isVisible, false);

  // Outside MAX the stack works silently.
  delete window.WebApp;
  const popLocal = max.pushBackHandler(() => calls.push("local"));
  popLocal();
}

console.log("PASS: MAX layer — start_param parser, Bridge fallbacks and BackButton stack (unit)");
