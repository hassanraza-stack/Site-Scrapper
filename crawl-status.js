#!/usr/bin/env node
/**
 * Show crawl progress and print resume commands for incomplete sections.
 *
 * Usage:
 *   node crawl-status.js
 *   npm run crawl:status
 */

const { loadEnv } = require("./lib/env");
const {
  ensureSchema,
  getCrawlProgress,
  closePool,
  getPool,
} = require("./lib/db");

loadEnv();

async function main() {
  await ensureSchema();
  const rows = await getCrawlProgress();
  const stats = await getPool().query(`
    SELECT
      (SELECT COUNT(*) FROM mcqs) AS unique_mcqs,
      (SELECT COUNT(*) FROM mcq_sections) AS links,
      (SELECT COUNT(*) FROM crawl_jobs WHERE status = 'done') AS pages_done,
      (SELECT COUNT(*) FROM crawl_jobs WHERE status = 'failed') AS pages_failed,
      (SELECT COUNT(*) FROM crawl_jobs WHERE status IN ('pending','running')) AS pages_pending
  `);

  console.log("\n========== Crawl status ==========");
  console.log(stats.rows[0]);
  console.log("");

  const incomplete = rows.filter((r) => r.crawl_status !== "complete");
  const complete = rows.filter((r) => r.crawl_status === "complete");

  console.log(`Complete sections: ${complete.length}`);
  console.log(`Incomplete sections: ${incomplete.length}`);
  console.log("");

  if (incomplete.length === 0) {
    console.log("All known sections are complete.");
    await closePool();
    return;
  }

  console.log("Incomplete (resume these):");
  for (const r of incomplete) {
    console.log(
      `  · ${r.slug}: ${r.crawl_status} — done ${r.pages_done}/${r.max_page || "?"} , left ${r.pages_left}`
    );
    console.log(`      npm run crawl:resume -- ${r.slug}`);
  }

  console.log("\nResume ALL incomplete:");
  console.log("  npm run crawl:resume");
  console.log("\nOr full nav crawl (skips done pages):");
  console.log("  npm start");
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
