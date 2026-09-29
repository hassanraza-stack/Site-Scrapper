#!/usr/bin/env node
/**
 * Crawl all sections from config/sections.json into PostgreSQL.
 *
 * Resume: crawl_jobs.status = done is skipped; pending/failed/running re-run.
 * Crashes: browser is recreated; section continues (does not skip to next).
 *
 * Usage:
 *   node crawl-all.js
 *   npm start
 *   npm run crawl:resume -- pak-study
 *   npm run crawl:status
 */

const fs = require("fs");
const path = require("path");
const { loadEnv } = require("./lib/env");
const {
  ensureSchema,
  upsertSection,
  resetStuckRunningJobs,
  getCrawlProgress,
  closePool,
  getPool,
} = require("./lib/db");
const { crawlSection, resolveSectionInput } = require("./lib/crawlSection");

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
  }
  return { sectionFilter, maxPages };
}

async function printProgress() {
  const rows = await getCrawlProgress();
  if (!rows.length) {
    console.log("  (no sections in DB yet)");
    return;
  }
  const complete = rows.filter((r) => r.crawl_status === "complete").length;
  const incomplete = rows.filter((r) => r.crawl_status !== "complete");
  console.log(
    `  Progress: ${complete} complete, ${incomplete.length} still need work (of ${rows.length} known)`
  );
  for (const r of incomplete) {
    console.log(
      `    · ${r.slug}: ${r.crawl_status} (${r.pages_done}/${r.max_page || "?"} done, ${r.pages_left} left)`
    );
    console.log(`        resume: npm run crawl:resume -- ${r.slug}`);
  }
}

async function main() {
  const { sectionFilter, maxPages } = parseArgs(process.argv.slice(2));

  await ensureSchema();
  await resetStuckRunningJobs();

  let list = sections;
  if (sectionFilter) {
    const one = resolveSectionInput(sectionFilter, sections);
    if (!one) {
      console.error("Unknown --section:", sectionFilter);
      process.exit(1);
    }
    list = [one];
  }

  for (const s of list) {
    await upsertSection(s);
  }

  console.log("");
  console.log("TestPoint auto-crawl");
  console.log("  Crash recovery: recreate browser, stay on same section");
  console.log("  Resume: skips done pages; use npm run crawl:resume -- <slug>");
  console.log(`  Sections this run: ${list.length}`);
  console.log("");
  await printProgress();
  console.log("");

  const started = Date.now();
  let sumNew = 0;
  let sumLinked = 0;

  for (let i = 0; i < list.length; i++) {
    const section = list[i];
    const navLabel =
      section.kind === "past_paper" ? "Past Papers" : "Important MCQs";
    console.log(
      `\n========== Nav ${i + 1}/${list.length} · ${navLabel} · ${section.title} ==========`
    );
    console.log(section.url);

    const result = await crawlSection(section, {
      maxPages,
      navProgress: { index: i + 1, total: list.length },
      browserOptions:
        process.env.CRAWL_DEBUG === "1"
          ? { headless: false, slowMo: 80, blockAssets: false }
          : {},
    });
    sumNew += result.newMcqs || 0;
    sumLinked += result.linkedOnly || 0;
    if (result.error) {
      console.error(
        `[${section.slug}] finished with error (pending pages remain): ${result.error}`
      );
      console.error(`  Resume: npm run crawl:resume -- ${section.slug}`);
    }
  }

  const stats = await getPool().query(`
    SELECT
      (SELECT COUNT(*) FROM mcqs) AS unique_mcqs,
      (SELECT COUNT(*) FROM mcq_sections) AS mcq_section_links,
      (SELECT COUNT(*) FROM crawl_jobs WHERE status = 'done') AS pages_done,
      (SELECT COUNT(*) FROM crawl_jobs WHERE status IN ('pending','failed','running')) AS pages_remaining
  `);
  console.log("\n========== Summary ==========");
  console.log("DB:", stats.rows[0]);
  console.log(`This run: ${sumNew} new MCQs, ${sumLinked} existing MCQs linked to another section`);
  console.log(`Elapsed: ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
  await printProgress();
  console.log("\nCommands:");
  console.log("  npm run crawl:status");
  console.log("  npm run crawl:resume -- islamic-studies-mcqs");
  console.log("  npm run crawl:resume -- pak-study");
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
