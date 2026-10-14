#!/usr/bin/env node
/**
 * Show past-paper category crawl progress.
 *
 * Usage:
 *   npm run crawl:categories:status
 *   node category-status.js
 */

const { loadEnv } = require("./lib/env");
const {
  ensureSchema,
  getCategoryCrawlProgress,
  closePool,
  getPool,
} = require("./lib/db");

loadEnv();

async function main() {
  await ensureSchema();

  const stats = await getPool().query(`
    SELECT
      (SELECT COUNT(*) FROM categories) AS categories,
      (SELECT COUNT(*) FROM mcq_categories) AS mcq_category_links,
      (SELECT COUNT(*) FROM category_crawl_jobs WHERE status = 'done') AS pages_done,
      (SELECT COUNT(*) FROM category_crawl_jobs WHERE status = 'failed') AS pages_failed,
      (SELECT COUNT(*) FROM category_crawl_jobs
        WHERE status IN ('pending','running')) AS pages_pending
  `);

  const rows = await getCategoryCrawlProgress();
  const complete = rows.filter((r) => r.crawl_status === "complete");
  const incomplete = rows.filter((r) => r.crawl_status !== "complete");

  console.log("\n========== Category crawl status ==========");
  console.log(stats.rows[0]);
  console.log(`Complete categories: ${complete.length}`);
  console.log(`Incomplete categories: ${incomplete.length}`);
  console.log("");

  if (incomplete.length === 0) {
    if (rows.length === 0) {
      console.log("No categories yet. Run:");
      console.log("  npm run crawl:categories");
    } else {
      console.log("All known categories are complete.");
    }
    await closePool();
    return;
  }

  // Group by past paper
  const bySection = new Map();
  for (const r of incomplete) {
    if (!bySection.has(r.section_slug)) bySection.set(r.section_slug, []);
    bySection.get(r.section_slug).push(r);
  }

  console.log("Incomplete (resume with full crawl — skips done pages):");
  for (const [sectionSlug, cats] of bySection) {
    console.log(`\n  Past paper: ${sectionSlug}`);
    console.log(`    npm run crawl:categories -- --section ${sectionSlug}`);
    for (const c of cats) {
      console.log(
        `    · ${c.slug}: ${c.crawl_status} — done ${c.pages_done}/${c.max_page || "?"} , left ${c.pages_left}`
      );
    }
  }

  console.log("\nResume ALL:");
  console.log("  npm run crawl:categories");
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
