/**
 * Single-page MCQ scraper (debug: HEADLESS=false).
 *
 * Usage:
 *   node scrape.js <url>
 *   HEADLESS=false node scrape.js https://testpointpk.com/important-mcqs/computer
 */

const fs = require("fs");
const path = require("path");
const { launchBrowser, gotoListingPage } = require("./lib/browser");
const { extractMcqsFromPage } = require("./lib/extractMcqs");

const DEFAULT_URL = "https://testpointpk.com/important-mcqs/computer";
const OUTPUT_DIR = path.join(__dirname, "output");

async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  console.log("========================================");
  console.log("  MCQ Scraper (single page)");
  console.log("========================================");
  console.log(`URL: ${url}`);
  console.log(`Headless: ${process.env.HEADLESS === "true"}\n`);

  const debugHeaded = process.env.HEADLESS !== "true";
  const { browser, context } = await launchBrowser({
    headless: !debugHeaded,
    slowMo: debugHeaded ? 80 : 0,
  });

  const page = await context.newPage();

  try {
    console.log("Navigating...");
    await gotoListingPage(page, url);

    const mcqs = await extractMcqsFromPage(page);
    console.log(`\nScraped ${mcqs.length} MCQs from this page.\n`);

    const preview = mcqs.slice(0, 3);
    for (const q of preview) {
      console.log(`--- #${q.id} ---`);
      console.log(`Q: ${q.questionEn || "(h5/urdu only)"}`);
      if (q.questionUr) console.log(`Ur: ${q.questionUr}`);
      for (const opt of q.options) {
        const mark = opt.label === q.correctLabel ? " ✓" : "";
        console.log(`  ${opt.label}) ${opt.text}${mark}`);
      }
      console.log(`Answer: ${q.correctAnswer || "(not marked)"}`);
      console.log("");
    }
    if (mcqs.length > 3) {
      console.log(`... and ${mcqs.length - 3} more (see output JSON)\n`);
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outFile = path.join(OUTPUT_DIR, `mcqs-${stamp}.json`);
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          scrapedAt: new Date().toISOString(),
          sourceUrl: url,
          count: mcqs.length,
          mcqs,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`Saved: ${outFile}`);

    if (debugHeaded) {
      console.log("\nKeeping browser open 5s for visual check...");
      await page.waitForTimeout(5000);
    }
  } catch (err) {
    console.error("\nScrape failed:", err.message);
    const shot = path.join(OUTPUT_DIR, "error-screenshot.png");
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`Screenshot (if possible): ${shot}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

main();
