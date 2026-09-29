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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchBrowser(options = {}) {
  const headless = options.headless !== undefined ? options.headless : isHeadless();
  const slowMo = options.slowMo !== undefined ? options.slowMo : headless ? 0 : 80;
  const blockAssets = options.blockAssets !== false;

  const browser = await chromium.launch({
    headless,
    slowMo,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--mute-audio",
      "--js-flags=--max-old-space-size=256",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT,
  });

  if (blockAssets) {
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        return route.abort();
      }
      const url = route.request().url();
      if (
        /googlesyndication|doubleclick|adservice|adsystem|facebook\.net|hotjar|analytics/i.test(
          url
        )
      ) {
        return route.abort();
      }
      return route.continue();
    });
  }

  const page = await context.newPage();
  return { browser, context, page };
}

async function closeBrowserSession(session) {
  if (!session) return;
  try {
    await session.browser.close();
  } catch {
    /* already dead */
  }
}

async function gotoListingPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page
    .waitForSelector('ol[type="A"]', { timeout: 30000 })
    .catch(() => {});
  await sleep(headlessDelay());
}

function headlessDelay() {
  return isHeadless() ? 500 : 1500;
}

function isCrashError(err) {
  const msg = (err && err.message) || String(err);
  return /crashed|Target closed|has been closed|Session closed|Browser closed|destroyed/i.test(
    msg
  );
}

module.exports = {
  launchBrowser,
  closeBrowserSession,
  gotoListingPage,
  isHeadless,
  isCrashError,
  sleep,
  DEFAULT_USER_AGENT,
};
