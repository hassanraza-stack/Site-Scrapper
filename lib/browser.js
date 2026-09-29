const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");

(function fixBrowserPath() {
  const homeBrowsers = path.join(os.homedir(), ".cache", "ms-playwright");
  const chromeRel = "chromium-1243/chrome-linux64/chrome";
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const envChrome = envPath && path.join(envPath, chromeRel);
  const homeChrome = path.join(homeBrowsers, chromeRel);

  if ((!envChrome || !fs.existsSync(envChrome)) && fs.existsSync(homeChrome)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = homeBrowsers;
  }
})();

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function isHeadless() {
  const v = process.env.HEADLESS;
  if (v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  return process.env.CRAWL_DEBUG !== "1";
}

async function launchBrowser(options = {}) {
  const headless = options.headless !== undefined ? options.headless : isHeadless();
  const slowMo = options.slowMo !== undefined ? options.slowMo : headless ? 0 : 80;

  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT,
  });
  return { browser, context };
}

async function gotoListingPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page
    .waitForSelector('ol[type="A"]', { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(headlessDelay());
}

function headlessDelay() {
  return isHeadless() ? 800 : 1500;
}

module.exports = {
  launchBrowser,
  gotoListingPage,
  isHeadless,
  DEFAULT_USER_AGENT,
};
