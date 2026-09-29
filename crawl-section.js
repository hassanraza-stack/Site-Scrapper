#!/usr/bin/env node
/**
 * Crawl one nav section (all paginated listing pages). Resume-safe.
 *
 * Usage:
 *   node crawl-section.js computer
 *   node crawl-section.js islamic-studies-mcqs
 *   node crawl-section.js pak-study
 *   npm run crawl:resume -- pak-study
 */

const fs = require("fs");
const path = require("path");
const { loadEnv } = require("./lib/env");
const { ensureSchema, resetStuckRunningJobs, closePool } = require("./lib/db");
const { crawlSection, resolveSectionInput } = require("./lib/crawlSection");

loadEnv();

const sections = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config", "sections.json"), "utf8")
);

function parseArgs(argv) {
  let input = null;
  let maxPages = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--max-pages=")) {
      maxPages = parseInt(arg.split("=")[1], 10);
      continue;
    }
    if (arg === "--max-pages" && argv[i + 1]) {
      maxPages = parseInt(argv[++i], 10);
      continue;
    }
    if (!arg.startsWith("--")) {
      input = arg;
    }
  }
  return { input, maxPages };
}

async function main() {
  const { input, maxPages } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error("Usage: node crawl-section.js <slug-or-url> [--max-pages N]");
    console.error("Examples:");
    console.error("  node crawl-section.js islamic-studies-mcqs");
    console.error("  node crawl-section.js pak-study");
    console.error("  npm run crawl:resume -- pak-study");
    console.error("  npm run crawl:status");
    process.exit(1);
  }

  const section = resolveSectionInput(input, sections);
  if (!section) {
    console.error("Unknown section:", input);
    console.error("Run: npm run crawl:status");
    process.exit(1);
  }

  await ensureSchema();
  await resetStuckRunningJobs();
  console.log("Crawling / resuming section:", section.title);
  console.log(section.url);
  if (maxPages) console.log("Limit: max-pages =", maxPages);

  const result = await crawlSection(section, { maxPages });
  console.log("Done.", result);
  if (result.leftoverPages > 0) {
    console.log(
      `\nStill incomplete. Run again:\n  npm run crawl:resume -- ${section.slug}`
    );
    process.exitCode = 2;
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
