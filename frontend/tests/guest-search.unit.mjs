// Unit checks for the guest menu search (P1-TASK-19, P1-DOC-6 «Поиск с опечатками").
// Vite bundles src/features/guest/search.ts alone (it has no imports) and Node runs it.
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
  build: { write: false, minify: false, lib: { entry: path.join(root, "src/features/guest/search.ts"), formats: ["es"], fileName: "guest-search" } },
});
const chunk = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk");
const bundlePath = path.join(outDir, "guest-search.unit.bundle.mjs");
fs.writeFileSync(bundlePath, chunk.code);
const { damerauLevenshtein, highlightRanges, normalizeText, searchItems, tokenize, wordMatch } = await import(pathToFileURL(bundlePath).href);

const option = (name) => ({ name });
const menu = [
  { id: "latte", name: "Латте", description: "Эспрессо и молоко", configuration: { variants: [{ name: "250 мл" }], modifier_groups: [{ name: "Молоко", options: [option("Обычное"), option("Овсяное")] }] } },
  { id: "cap", name: "Капучино", description: "Классика", configuration: { variants: [], modifier_groups: [] } },
  { id: "flat", name: "Флэт уайт", description: null, allergens: ["молоко"], configuration: null },
  { id: "croissant", name: "Круассан", description: "Сливочное масло", configuration: null },
  { id: "honey", name: "Медовик", description: "Торт с мёдом", configuration: null },
  { id: "cocoa", name: "Какао", description: "Можно на овсяном молоке", configuration: null },
  { id: "tea", name: "Чай улун", tags: ["без кофеина"], configuration: null },
];
const ids = (query) => searchItems(menu, query).map((hit) => hit.item.id);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

check("normalisation: case, ё→е, punctuation and spaces", () => {
  assert.equal(normalizeText("  МЁД,  Латте!! "), "мед латте");
  assert.deepEqual(tokenize("Флэт-уайт  250мл"), ["флэт", "уайт", "250мл"]);
  assert.deepEqual(tokenize("   "), []);
});

check("Damerau–Levenshtein: substitution, transposition, limit", () => {
  assert.equal(damerauLevenshtein("капучтно", "капучино"), 1);
  assert.equal(damerauLevenshtein("капуично", "капучино"), 1, "adjacent transposition costs 1");
  assert.equal(damerauLevenshtein("латте", "латте"), 0);
  assert.equal(damerauLevenshtein("кофе", "чай", 1), 2, "early exit returns limit + 1");
});

check("«капучтно» finds «Капучино» (P1-DOC-6 scenario)", () => {
  assert.deepEqual(ids("капучтно"), ["cap"]);
});

check("«овсян» finds drinks with oat milk (add-on option or description)", () => {
  const found = ids("овсян");
  assert.ok(found.includes("latte"), "Латте has the «Овсяное» option");
  assert.ok(found.includes("cocoa"), "Какао mentions oat milk in the description");
  assert.ok(!found.includes("cap"));
});

check("partial input matches word prefixes", () => {
  assert.deepEqual(ids("кру"), ["croissant"]);
  assert.deepEqual(ids("флэт"), ["flat"]);
  assert.equal(ids("ла")[0], "latte");
});

check("ё and е are the same letter", () => {
  assert.deepEqual(ids("мед"), ["honey"]);
  assert.deepEqual(ids("мёдовик"), ["honey"]);
});

check("one typo only for words of 4+ letters", () => {
  assert.equal(wordMatch("чаи", "чай"), 0, "3-letter word: no typo tolerance");
  assert.equal(wordMatch("латтэ", "латте"), 1);
  assert.equal(wordMatch("кпучино", "капучино"), 1, "deletion");
  assert.equal(wordMatch("капучт", "капучино"), 1, "partial input with a typo");
  assert.deepEqual(ids("капчтно"), [], "two typos are not a match");
});

check("every query word must match; tags are searched", () => {
  assert.deepEqual(ids("латте овсяное"), ["latte"]);
  assert.deepEqual(ids("латте круассан"), []);
  assert.deepEqual(ids("без кофеина"), ["tea"]);
});

check("name matches rank above description matches", () => {
  // «молоко» is in Латте's add-on group name and description, in Флэт уайт's allergens and in Какао's description.
  const found = ids("молоко");
  assert.ok(found.indexOf("latte") < found.indexOf("cocoa"));
  assert.ok(found.indexOf("flat") < found.indexOf("cocoa"));
});

check("empty query returns nothing; unknown words return nothing", () => {
  assert.deepEqual(ids(""), []);
  assert.deepEqual(ids("  !! "), []);
  assert.deepEqual(ids("шаурма"), []);
});

check("highlight ranges cover the matched part of the name", () => {
  assert.deepEqual(highlightRanges("Капучино", ["кап"]), [[0, 3]]);
  assert.deepEqual(highlightRanges("Капучино", ["капучтно"]), [[0, 8]]);
  assert.deepEqual(highlightRanges("Флэт уайт", ["уайт"]), [[5, 9]]);
  assert.deepEqual(searchItems(menu, "круас")[0].highlights, [[0, 5]]);
});

console.log(`PASS: guest search — ${passed} checks`);
