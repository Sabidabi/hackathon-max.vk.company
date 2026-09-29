// Chromium for the smoke tests on any machine, without `playwright install`:
// - BROWSER_CHANNEL set (e.g. `msedge`, `chrome`) → that installed browser;
// - BROWSER_EXECUTABLE set → that binary;
// - otherwise the Playwright-managed Chromium, and when its pinned revision is missing,
//   any Chromium under PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers in the cloud container),
//   then the local Chrome channel.
const fs = require("node:fs");
const path = require("node:path");

function preinstalledChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse();
    } catch {
      continue;
    }
    for (const entry of entries) {
      for (const binary of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-win/chrome.exe", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const candidate = path.join(root, entry, binary);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function launchChromium(chromium, options = {}) {
  const base = { headless: true, ...options };
  if (process.env.BROWSER_CHANNEL) return chromium.launch({ ...base, channel: process.env.BROWSER_CHANNEL });
  if (process.env.BROWSER_EXECUTABLE) return chromium.launch({ ...base, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    return await chromium.launch(base);
  } catch (error) {
    const executablePath = preinstalledChromium();
    if (executablePath) return chromium.launch({ ...base, executablePath });
    try {
      return await chromium.launch({ ...base, channel: "chrome" });
    } catch {
      throw error;
    }
  }
}

module.exports = { launchChromium };
