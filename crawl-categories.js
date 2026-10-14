#!/usr/bin/env node
/**
 * Crawl past-paper category links (/paper-mcqs/...) and link MCQs to categories.
 * Only processes kind=past_paper from config/sections.json.
 * Resume: category_crawl_jobs.status=done is skipped.
 *
 * Usage:
 *   npm run crawl:categories
 *   node crawl-categories.js
 *   node crawl-categories.js --section islamabad-police-constable,-asi-past-papers,-syllabus,-test-preparation
 *   pm2 start crawl-categories.js --name mcq-categories --time
 */

const fs = require("fs");
const path = require("path");
const { loadEnv } = require("./lib/env");
const {
  ensureSchema,
  upsertSection,
  resetStuckCategoryJobs,
  getCategoryCrawlProgress,
  closePool,
  getPool,
} = require("./lib/db");
const { resolveSectionInput } = require("./lib/crawlSection");
const { crawlPastPaperCategories } = require("./lib/crawlCategories");

loadEnv();

const sections = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config", "sections.json"), "utf8")
);

function parseArgs(argv) {
  let sectionFilter = null;
  let maxPages = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--section" && argv[i + 1]) sectionFilter = argv[++i];
    if (arg.startsWith("--section=")) sectionFilter = arg.split("=")[1];
    if (arg === "--max-pages" && argv[i + 1]) maxPages = parseInt(argv[++i], 10);
    if (arg.startsWith("--max-pages=")) maxPages = parseInt(arg.split("=")[1], 10);
    // bare slug/url as first positional
    if (!arg.startsWith("-") && !sectionFilter && i === 0) sectionFilter = arg;
  }
  return { sectionFilter, maxPages };
}

async function printCategoryProgress() {
  const rows = await getCategoryCrawlProgress();
  if (!rows.length) {
    console.log("  (no categories in DB yet)");
    return;
  }
  const complete = rows.filter((r) => r.crawl_status === "complete").length;
  const incomplete = rows.filter((r) => r.crawl_status !== "complete");
  console.log(
    `  Categories: ${complete} complete, ${incomplete.length} still need work (of ${rows.length})`
  );
  for (const r of incomplete.slice(0, 20)) {
    console.log(
      `    · [${r.section_slug}] ${r.slug}: ${r.crawl_status} ` +
        `(${r.pages_done}/${r.max_page || "?"} done, ${r.pages_left} left)`
    );
  }
  if (incomplete.length > 20) {
    console.log(`    … and ${incomplete.length - 20} more`);
  }
}

async function main() {
  const { sectionFilter, maxPages } = parseArgs(process.argv.slice(2));

  await ensureSchema();
  await resetStuckCategoryJobs();

  let list = sections.filter((s) => s.kind === "past_paper");
  if (sectionFilter) {
    const one = resolveSectionInput(sectionFilter, sections);
    if (!one) {
      console.error("Unknown --section:", sectionFilter);
      process.exit(1);
    }
    if (one.kind !== "past_paper") {
      console.error(
        `Section "${one.slug}" is kind=${one.kind}; category crawl only supports past_paper`
      );
      process.exit(1);
    }
    list = [one];
  }

  for (const s of list) {
    await upsertSection(s);
  }

  console.log("");
  console.log("TestPoint past-paper category crawl");
  console.log("  Order: each past paper → its /paper-mcqs categories one-by-one");
  console.log("  Dedup: existing mcqs reused; only mcq_categories links added");
  console.log(`  Past papers this run: ${list.length}`);
  console.log("");
  await printCategoryProgress();
  console.log("");

  const started = Date.now();
  let sumNew = 0;
  let sumLinked = 0;
  let sumCats = 0;

  for (let i = 0; i < list.length; i++) {
    const section = list[i];
    console.log(
      `\n========== Past paper ${i + 1}/${list.length} · ${section.title} ==========`
    );
    console.log(section.url);

    const result = await crawlPastPaperCategories(section, {
      maxPages,
      navProgress: { index: i + 1, total: list.length },
      browserOptions:
        process.env.CRAWL_DEBUG === "1"
          ? { headless: false, slowMo: 80, blockAssets: false }
          : {},
    });

    sumNew += result.newMcqs || 0;
    sumLinked += result.linkedOnly || 0;
    sumCats += result.categoriesFound || 0;

    if (result.error) {
      console.error(
        `[${section.slug}] finished with error: ${result.error}`
      );
    }
  }

  const stats = await getPool().query(`
    SELECT
      (SELECT COUNT(*) FROM mcqs) AS unique_mcqs,
      (SELECT COUNT(*) FROM categories) AS categories,
      (SELECT COUNT(*) FROM mcq_categories) AS mcq_category_links,
      (SELECT COUNT(*) FROM category_crawl_jobs WHERE status = 'done') AS cat_pages_done,
      (SELECT COUNT(*) FROM category_crawl_jobs
        WHERE status IN ('pending','failed','running')) AS cat_pages_remaining
  `);

  console.log("\n========== Summary ==========");
  console.log("DB:", stats.rows[0]);
  console.log(
    `This run: ${sumCats} categories seen, ${sumNew} new MCQs, ${sumLinked} existing MCQs linked to a category`
  );
  console.log(`Elapsed: ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
  await printCategoryProgress();
  console.log("\nCommands:");
  console.log("  npm run crawl:categories:status");
  console.log(
    "  npm run crawl:categories -- --section islamabad-police-constable,-asi-past-papers,-syllabus,-test-preparation"
  );
  await closePool();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await closePool();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
