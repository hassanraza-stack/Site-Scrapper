#!/usr/bin/env node
/**
 * Embed all MCQs via OpenRouter (openai/text-embedding-3-small by default).
 * Loops until every retryable MCQ is done. Safe to Ctrl+C and re-run.
 *
 * Usage:
 *   npm run embed
 *   node embed-all.js
 *
 * Env:
 *   OPENROUTER_API_KEY   required
 *   EMBED_MODEL          default openai/text-embedding-3-small
 *   EMBED_BATCH_SIZE     default 64
 *   EMBED_MAX_ATTEMPTS   default 5
 *   EMBED_DELAY_MS       pause between batches (default 200)
 */

const { loadEnv } = require("./lib/env");
const {
  ensureSchema,
  getPendingEmbedMcqs,
  markEmbedDone,
  markEmbedFailed,
  getEmbedProgress,
  countRetryableEmbeds,
  closePool,
} = require("./lib/db");
const {
  embedModel,
  embedBatchSize,
  embedMaxAttempts,
  buildEmbedText,
  estimateTokens,
  createEmbeddings,
  sleep,
} = require("./lib/embed");

loadEnv();

async function main() {
  const model = embedModel();
  const batchSize = embedBatchSize();
  const maxAttempts = embedMaxAttempts();
  const delayMs = parseInt(process.env.EMBED_DELAY_MS || "200", 10);

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set (see .env.example)");
  }

  console.log("========== MCQ embed-all ==========");
  console.log(`Model: ${model}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Max attempts: ${maxAttempts}`);

  await ensureSchema();

  let progress = await getEmbedProgress();
  let remaining = await countRetryableEmbeds(maxAttempts);
  console.log(
    `Start: total=${progress.total} done=${progress.done} pending=${progress.pending} failed=${progress.failed} retryable=${remaining}`
  );

  if (remaining === 0) {
    if (progress.failed > 0) {
      console.log(
        `\nNo retryable rows left, but ${progress.failed} failed (hit max attempts). Re-run after raising EMBED_MAX_ATTEMPTS or reset embed_attempts.`
      );
    } else {
      console.log("\nAll MCQs already embedded.");
    }
    await closePool();
    return;
  }

  const started = Date.now();
  let batches = 0;
  let embeddedThisRun = 0;
  let failedThisRun = 0;
  let tokensEst = 0;

  while (true) {
    remaining = await countRetryableEmbeds(maxAttempts);
    if (remaining === 0) break;

    const rows = await getPendingEmbedMcqs(batchSize, maxAttempts);
    if (rows.length === 0) break;

    const texts = rows.map((r) => buildEmbedText(r));
    const batchTokens = texts.reduce((s, t) => s + estimateTokens(t), 0);
    batches += 1;

    console.log(
      `\n[batch ${batches}] embedding ${rows.length} MCQs (~${batchTokens} tokens est) · remaining before=${remaining}`
    );

    try {
      const { embeddings, usage } = await createEmbeddings(texts);
      for (let i = 0; i < rows.length; i++) {
        await markEmbedDone(rows[i].source_id, texts[i], embeddings[i], model);
        embeddedThisRun += 1;
      }
      tokensEst += usage?.total_tokens || batchTokens;
      if (usage?.total_tokens) {
        console.log(`  API usage tokens: ${usage.total_tokens}`);
      }
    } catch (e) {
      console.error(`  Batch failed: ${e.message}`);
      for (const row of rows) {
        await markEmbedFailed(row.source_id, e.message.slice(0, 500));
        failedThisRun += 1;
      }
      // Back off before next batch on API errors
      await sleep(Math.max(delayMs, 2000));
      continue;
    }

    progress = await getEmbedProgress();
    remaining = await countRetryableEmbeds(maxAttempts);
    const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
    console.log(
      `  Progress: done=${progress.done}/${progress.total} · retryable left=${remaining} · this run +${embeddedThisRun} · ${elapsedMin} min`
    );

    if (delayMs > 0) await sleep(delayMs);
  }

  progress = await getEmbedProgress();
  remaining = await countRetryableEmbeds(maxAttempts);
  const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
  const estCost = ((tokensEst / 1_000_000) * 0.02).toFixed(4);

  console.log("\n========== Summary ==========");
  console.log({
    model,
    done: progress.done,
    pending: progress.pending,
    failed: progress.failed,
    total: progress.total,
    retryable_left: remaining,
    embedded_this_run: embeddedThisRun,
    failed_batches_rows: failedThisRun,
    tokens_est: tokensEst,
    cost_est_usd_at_0_02_per_m: estCost,
    elapsed_min: elapsedMin,
  });

  if (remaining === 0 && progress.failed === 0) {
    console.log("All MCQs embedded.");
  } else if (remaining === 0 && progress.failed > 0) {
    console.log(
      `${progress.failed} MCQs exhausted retries. Inspect embed_error or raise EMBED_MAX_ATTEMPTS.`
    );
  }

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
