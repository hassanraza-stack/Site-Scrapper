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
 *   EMBED_MAX_CHARS      per-input char budget (default 28000, under 8192 tokens)
 *   EMBED_RESET_FAILED   default 1 — re-queue failed rows at start
 */

const { loadEnv } = require("./lib/env");
const {
  ensureSchema,
  getPendingEmbedMcqs,
  markEmbedDone,
  markEmbedFailed,
  getEmbedProgress,
  countRetryableEmbeds,
  resetFailedEmbeds,
  closePool,
} = require("./lib/db");
const {
  embedModel,
  embedBatchSize,
  embedMaxAttempts,
  maxEmbedChars,
  buildEmbedText,
  estimateTokens,
  createEmbeddings,
  embedOneWithTruncate,
  sleep,
} = require("./lib/embed");

loadEnv();

async function embedBatchOrFallback(rows, texts, model) {
  let embedded = 0;
  let failed = 0;
  let tokens = 0;

  try {
    const { embeddings, usage, inputs } = await createEmbeddings(texts);
    const savedTexts = inputs || texts;
    for (let i = 0; i < rows.length; i++) {
      await markEmbedDone(rows[i].source_id, savedTexts[i], embeddings[i], model);
      embedded += 1;
    }
    tokens += usage?.total_tokens || savedTexts.reduce((s, t) => s + estimateTokens(t), 0);
    if (usage?.total_tokens) {
      console.log(`  API usage tokens: ${usage.total_tokens}`);
    }
    return { embedded, failed, tokens };
  } catch (e) {
    console.error(`  Batch failed: ${e.message}`);
    console.log("  Falling back to per-item embeds for this batch...");

    for (let i = 0; i < rows.length; i++) {
      try {
        const one = await embedOneWithTruncate(texts[i]);
        await markEmbedDone(rows[i].source_id, one.text, one.embedding, model);
        embedded += 1;
        tokens += one.usage?.total_tokens || estimateTokens(one.text);
      } catch (itemErr) {
        console.error(
          `  Item failed ${rows[i].source_id}: ${String(itemErr.message).slice(0, 200)}`
        );
        await markEmbedFailed(rows[i].source_id, String(itemErr.message).slice(0, 500));
        failed += 1;
      }
    }
    return { embedded, failed, tokens };
  }
}

async function main() {
  const model = embedModel();
  const batchSize = embedBatchSize();
  const maxAttempts = embedMaxAttempts();
  const delayMs = parseInt(process.env.EMBED_DELAY_MS || "200", 10);
  const resetFailed =
    (process.env.EMBED_RESET_FAILED || "1").toLowerCase() !== "0" &&
    (process.env.EMBED_RESET_FAILED || "1").toLowerCase() !== "false";

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set (see .env.example)");
  }

  console.log("========== MCQ embed-all ==========");
  console.log(`Model: ${model}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Max attempts: ${maxAttempts}`);
  console.log(`Max chars / input: ${maxEmbedChars()}`);

  await ensureSchema();

  if (resetFailed) {
    const n = await resetFailedEmbeds();
    if (n > 0) console.log(`Re-queued ${n} previously failed MCQs`);
  }

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

    const result = await embedBatchOrFallback(rows, texts, model);
    embeddedThisRun += result.embedded;
    failedThisRun += result.failed;
    tokensEst += result.tokens;

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
    failed_this_run: failedThisRun,
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
