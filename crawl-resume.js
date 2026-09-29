#!/usr/bin/env node
/**
 * Resume incomplete section(s) only — skips pages already done.
 *
 * Usage:
 *   npm run crawl:resume                         # all incomplete sections
 *   npm run crawl:resume -- islamic-studies-mcqs # one section
 *   npm run crawl:resume -- pak-study
 *   node crawl-section.js computer               # same for one section
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
  let slug = null;
  let maxPages = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--max-pages" && argv[i + 1]) {
      maxPages = parseInt(argv[++i], 10);
      continue;
    }
    if (arg.startsWith("--max-pages=")) {
      maxPages = parseInt(arg.split("=")[1], 10);
      continue;
    }
    if (!arg.startsWith("--")) slug = arg;
  }
  return { slug, maxPages };
}

async function main() {
  const { slug, maxPages } = parseArgs(process.argv.slice(2));
  await ensureSchema();
  await resetStuckRunningJobs();

  for (const s of sections) {
    await upsertSection(s);
  }

  let list;
  if (slug) {
    const one = resolveSectionInput(slug, sections);
    if (!one) {
      console.error("Unknown section:", slug);
      console.error("Tip: npm run crawl:status");
      process.exit(1);
    }
    list = [one];
    console.log(`\nResuming ONE section: ${one.slug}\n`);
  } else {
    const progress = await getCrawlProgress();
    const incompleteSlugs = new Set(
      progress.filter((r) => r.crawl_status !== "complete").map((r) => r.slug)
    );
    // Also include config sections never started
    list = sections.filter((s) => {
      const row = progress.find((p) => p.slug === s.slug);
      return !row || row.crawl_status !== "complete";
    });
    console.log(
      `\nResuming ${list.length} incomplete section(s) (skips pages already done)\n`
    );
    if (list.length === 0) {
      console.log("Nothing to resume — all complete.");
      await closePool();
      return;
    }
    for (const s of list) {
      console.log(`  · ${s.slug}`);
    }
    console.log("");
  }

  const started = Date.now();
  for (let i = 0; i < list.length; i++) {
    const section = list[i];
    console.log(
      `\n========== Resume ${i + 1}/${list.length} · ${section.title} ==========`
    );
    const result = await crawlSection(section, {
      maxPages,
      navProgress: { index: i + 1, total: list.length },
    });
    console.log("Result:", {
      newMcqs: result.newMcqs,
      linkedOnly: result.linkedOnly,
      leftoverPages: result.leftoverPages,
      skipped: result.skipped,
    });
  }

  const stats = await getPool().query(`
    SELECT
      (SELECT COUNT(*) FROM mcqs) AS unique_mcqs,
      (SELECT COUNT(*) FROM crawl_jobs WHERE status = 'done') AS pages_done,
      (SELECT COUNT(*) FROM crawl_jobs WHERE status IN ('pending','failed','running')) AS pages_left
  `);
  console.log("\n========== Resume summary ==========");
  console.log(stats.rows[0]);
  console.log(`Elapsed: ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
  console.log("\nCheck again: npm run crawl:status");
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
