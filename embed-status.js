#!/usr/bin/env node
/**
 * Show embedding progress.
 *
 * Usage:
 *   node embed-status.js
 *   npm run embed:status
 */

const { loadEnv } = require("./lib/env");
const {
  ensureSchema,
  getEmbedProgress,
  countRetryableEmbeds,
  closePool,
  getPool,
} = require("./lib/db");
const { embedModel, embedMaxAttempts } = require("./lib/embed");

loadEnv();

async function main() {
  await ensureSchema();
  const maxAttempts = embedMaxAttempts();
  const progress = await getEmbedProgress();
  const remaining = await countRetryableEmbeds(maxAttempts);

  const samples = await getPool().query(`
    SELECT source_id, embed_status, embed_attempts, LEFT(embed_error, 120) AS embed_error
    FROM mcqs
    WHERE embed_status = 'failed'
    ORDER BY embed_attempts DESC, source_id
    LIMIT 10
  `);

  console.log("\n========== Embed status ==========");
  console.log(`Model (configured): ${embedModel()}`);
  console.log(progress);
  console.log(`Retryable remaining (attempts < ${maxAttempts}): ${remaining}`);
  console.log("");

  if (progress.done === progress.total && progress.total > 0) {
    console.log("All MCQs embedded.");
  } else if (remaining > 0) {
    console.log("Continue with:");
    console.log("  npm run embed");
  } else if (progress.failed > 0) {
    console.log("No retryable rows; some failures exhausted attempts.");
    console.log("Sample failures:");
    for (const r of samples.rows) {
      console.log(
        `  · ${r.source_id} attempts=${r.embed_attempts} err=${r.embed_error || "(none)"}`
      );
    }
  } else {
    console.log("No MCQs in database yet.");
  }

  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
