/**
 * Build embed documents and call OpenRouter embeddings API.
 * Model: openai/text-embedding-3-small (1536 dims) by default.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";

function embedModel() {
  return process.env.EMBED_MODEL || "openai/text-embedding-3-small";
}

function embedBatchSize() {
  return parseInt(process.env.EMBED_BATCH_SIZE || "64", 10);
}

function embedMaxAttempts() {
  return parseInt(process.env.EMBED_MAX_ATTEMPTS || "5", 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One search document per MCQ: sections + question + options + answer + explanation.
 */
function buildEmbedText(row) {
  const lines = [];
  if (row.section_titles) {
    lines.push(`Section: ${row.section_titles}`);
  }
  if (row.question_en) {
    lines.push(`Question: ${row.question_en}`);
  }
  if (row.question_ur) {
    lines.push(`Question (Urdu): ${row.question_ur}`);
  }

  const options = Array.isArray(row.options) ? row.options : [];
  if (options.length) {
    lines.push("Options:");
    for (const opt of options) {
      lines.push(`${opt.label}. ${opt.text}`);
    }
  }

  if (row.correct_label || row.correct_text) {
    const label = row.correct_label ? `${row.correct_label} ` : "";
    lines.push(`Correct: ${label}${row.correct_text || ""}`.trim());
  }
  if (row.explanation) {
    lines.push(`Explanation: ${row.explanation}`);
  }

  return lines.join("\n").trim() || "empty mcq";
}

/**
 * Rough token estimate (~4 chars/token) for progress / budget logging.
 */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

/**
 * POST batch embeddings to OpenRouter (OpenAI-compatible).
 * @param {string[]} inputs
 * @returns {Promise<{ embeddings: number[][], usage?: object }>}
 */
async function createEmbeddings(inputs, { retries = 3 } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set (see .env.example)");
  }
  const model = embedModel();
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "https://github.com/mcq-scraper",
          "X-Title": process.env.OPENROUTER_APP_TITLE || "MCQ Scraper Embeddings",
        },
        body: JSON.stringify({ model, input: inputs }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          body?.error?.message ||
          body?.error ||
          JSON.stringify(body) ||
          res.statusText;
        const err = new Error(`OpenRouter embeddings ${res.status}: ${msg}`);
        err.status = res.status;
        throw err;
      }

      const data = body.data;
      if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new Error(
          `Unexpected embeddings response: got ${data?.length ?? 0} vectors for ${inputs.length} inputs`
        );
      }

      // OpenAI returns data sorted by index; sort defensively
      const sorted = [...data].sort((a, b) => a.index - b.index);
      const embeddings = sorted.map((d) => d.embedding);
      return { embeddings, usage: body.usage, model };
    } catch (e) {
      lastErr = e;
      const retryable =
        e.status === 429 ||
        e.status === 500 ||
        e.status === 502 ||
        e.status === 503 ||
        e.code === "ECONNRESET" ||
        e.name === "TypeError"; // fetch network failure
      if (!retryable || attempt === retries) break;
      const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      await sleep(backoff);
    }
  }

  throw lastErr;
}

module.exports = {
  embedModel,
  embedBatchSize,
  embedMaxAttempts,
  buildEmbedText,
  estimateTokens,
  createEmbeddings,
  sleep,
};
