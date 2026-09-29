// Bot button payloads → in-app paths. The server
// builds them in backend/app/bot/links.py; this checks the mini-app understands each one.
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
    lib: { entry: path.join(root, "src/max/startParam.ts"), formats: ["es"], fileName: "start-param" },
  },
});
const chunk = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk");
const bundlePath = path.join(outDir, "bot-links.unit.bundle.mjs");
fs.writeFileSync(bundlePath, chunk.code);
const { parseStartParam, startTargetPath } = await import(pathToFileURL(bundlePath).href);
const toPath = (payload) => {
  const target = parseStartParam(payload);
  return target ? startTargetPath(target) : null;
};

assert.equal(toPath("settings"), "/notifications");
assert.equal(toPath("manage_abc123"), "/manage/abc123");
assert.equal(toPath("manage_abc123_s_menu"), "/manage/abc123/menu");
assert.equal(toPath("manage_abc123_s_analytics"), "/manage/abc123/analytics");
assert.equal(toPath("manage_abc123_s_team"), "/manage/abc123/more/team");
assert.equal(toPath("manage_abc123_s_import"), "/manage/abc123/more/import");
assert.equal(toPath("manage_abc123_s_messages"), "/manage/abc123/more/messages");
assert.equal(toPath("manage_ab_c-1_s_messages"), "/manage/ab_c-1/more/messages");
// An unknown section is still a cabinet link of that (odd) public id, never another screen.
assert.equal(toPath("manage_abc_s_payments"), "/manage/abc_s_payments");
const itemKey = "0f8fad5b-d9cb-469f-a165-70867728950e";
assert.equal(toPath(`r_abc123_i_${itemKey}`), `/r/abc123/i/${itemKey}`);
assert.equal(toPath("r_abc123"), "/r/abc123");
assert.equal(toPath("settings "), null);
console.log("bot-links.unit: ok");
