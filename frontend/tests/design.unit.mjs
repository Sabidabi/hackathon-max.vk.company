// Unit checks for the «Синица» design layer (src/design), run in Node without a browser:
// 1) text colour pairs of tokens.css meet WCAG AA (P1-DOC-3 «Контраст»);
// 2) the dependency-free QR encoder matches the Python `qrcode` reference matrices in
//    tests/fixtures/qr-reference.json (generated with qrcode 8.x, byte mode, fixed mask).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
fs.mkdirSync(outDir, { recursive: true });

// --- Tokens: contrast ---------------------------------------------------------------------
const css = fs.readFileSync(path.join(root, "src/design/tokens.css"), "utf8");
const token = (name) => {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(match, `Token --${name} must be a hex colour`);
  return match[1];
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Brandbook values are copied verbatim.
assert.equal(token("sinitsa-blue"), "#2450FF");
assert.equal(token("sinitsa-ink"), "#151821");
assert.equal(token("sinitsa-canvas"), "#F6F7FB");
assert.equal(token("sinitsa-surface"), "#FFFFFF");
assert.equal(token("sinitsa-muted"), "#5C6678");

const textPairs = [
  ["sinitsa-ink", "sinitsa-surface"],
  ["sinitsa-ink", "sinitsa-canvas"],
  ["sinitsa-ink", "sinitsa-sky"],
  ["sinitsa-muted", "sinitsa-surface"],
  ["sinitsa-muted", "sinitsa-canvas"],
  ["sinitsa-muted", "sinitsa-sky"],
  ["sinitsa-blue", "sinitsa-surface"],
  ["sinitsa-blue", "sinitsa-canvas"],
  ["sinitsa-blue", "sinitsa-sky"],
  ["sinitsa-on-blue", "sinitsa-blue"],
  ["sinitsa-on-blue", "sinitsa-blue-press"],
  ["sinitsa-on-blue", "sinitsa-danger"],
  ["sinitsa-success", "sinitsa-surface"],
  ["sinitsa-success", "sinitsa-success-bg"],
  ["sinitsa-danger", "sinitsa-surface"],
  ["sinitsa-danger", "sinitsa-danger-bg"],
  ["sinitsa-warning", "sinitsa-surface"],
  ["sinitsa-warning", "sinitsa-warning-bg"],
  ["sinitsa-surface", "sinitsa-ink"],
];
for (const [fg, bg] of textPairs) {
  const ratio = contrast(token(fg), token(bg));
  assert.ok(ratio >= 4.5, `--${fg} on --${bg} is ${ratio.toFixed(2)}:1, needs ≥ 4.5:1`);
}
// Control boundaries (WCAG 1.4.11): ≥ 3:1 against both backgrounds.
for (const bg of ["sinitsa-surface", "sinitsa-canvas"]) {
  const ratio = contrast(token("sinitsa-line-strong"), token(bg));
  assert.ok(ratio >= 3, `--sinitsa-line-strong on --${bg} is ${ratio.toFixed(2)}:1, needs ≥ 3:1`);
}

// --- QR encoder ---------------------------------------------------------------------------
const result = await build({
  configFile: false,
  root,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    lib: { entry: path.join(root, "src/design/qr.ts"), formats: ["es"], fileName: "qr" },
  },
});
const chunk = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk");
const bundlePath = path.join(outDir, "design-qr.unit.bundle.mjs");
fs.writeFileSync(bundlePath, chunk.code);
const { encodeQr, qrPath } = await import(pathToFileURL(bundlePath).href);

const references = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/qr-reference.json"), "utf8"));
for (const reference of references) {
  const modules = encodeQr(reference.text, { errorCorrection: reference.ecc, mask: reference.mask });
  const rows = modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));
  assert.equal(rows.length, reference.version * 4 + 17, `Version for ${reference.text.slice(0, 40)}…`);
  assert.deepEqual(rows, reference.rows, `Matrix for v${reference.version} ${reference.ecc} mask ${reference.mask}`);
}

// Automatic mask choice still yields a valid symbol of the same version.
const auto = encodeQr(references[0].text);
assert.equal(auto.length, references[0].rows.length);
assert.match(qrPath([[true, false], [false, true]], 1), /^M1 1h1v1h-1zM2 2h1v1h-1z$/);
assert.throws(() => encodeQr("x".repeat(3000)), RangeError);

console.log(`PASS: design tokens contrast (${textPairs.length} text pairs) and QR encoder (${references.length} reference symbols)`);

// --- Venue theme contrast (P1-TASK-31) ------------------------------------------------------
{
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    build: { write: false, minify: false, lib: { entry: path.join(root, "src/features/admin/design/contrast.ts"), formats: ["es"], fileName: "contrast" } },
  });
  const chunk = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk");
  const bundle = path.join(outDir, "design-contrast.unit.bundle.mjs");
  fs.writeFileSync(bundle, chunk.code);
  const { contrastIssues, contrastRatio, fixIssue } = await import(pathToFileURL(bundle).href);
  assert.equal(Math.round(contrastRatio("#000000", "#FFFFFF")), 21);
  const readable = { primary_color: "#234738", background_color: "#ECEFE6", surface_color: "#FFFEF8", text_color: "#17231E" };
  assert.deepEqual(contrastIssues(readable), [], "Bistro theme is readable");
  const bad = { primary_color: "#FFE0E0", background_color: "#FFFFFF", surface_color: "#FFFFFF", text_color: "#CCCCCC" };
  const issues = contrastIssues(bad);
  assert.deepEqual(issues.map((issue) => issue.pair).sort(), ["accent_surface", "text_background", "text_surface"]);
  let fixed = bad;
  for (const issue of contrastIssues(fixed)) fixed = fixIssue(fixed, issue);
  assert.deepEqual(contrastIssues(fixed), [], "«Исправить» makes every pair readable");
  assert.ok(contrastRatio(fixed.text_color, "#FFFFFF") < 6, "The fix stays close to the chosen colour, not plain black");
  const dark = { primary_color: "#333333", background_color: "#0E1011", surface_color: "#191C1D", text_color: "#555555" };
  let darkFixed = dark;
  for (const issue of contrastIssues(darkFixed)) darkFixed = fixIssue(darkFixed, issue);
  assert.deepEqual(contrastIssues(darkFixed), []);
  console.log("PASS: venue theme contrast and «Исправить»");
}
