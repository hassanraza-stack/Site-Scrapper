/**
 * Build embed documents and call OpenRouter embeddings API.
 * Model: openai/text-embedding-3-small (1536 dims) by default.
 * Per-input limit is 8192 tokens — we truncate below that.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";

/** Conservative char budget (~4 chars/token English; denser for Urdu). Stay under 8192. */
const DEFAULT_MAX_CHARS = 28000; // ~7000 tokens

function embedModel() {
  return process.env.EMBED_MODEL || "openai/text-embedding-3-small";
}

function embedBatchSize() {
  return parseInt(process.env.EMBED_BATCH_SIZE || "64", 10);
}

function embedMaxAttempts() {
  return parseInt(process.env.EMBED_MAX_ATTEMPTS || "5", 10);
}

function maxEmbedChars() {
  return parseInt(process.env.EMBED_MAX_CHARS || String(DEFAULT_MAX_CHARS), 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function truncateToChars(text, maxChars) {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  if (maxChars <= 40) return s.slice(0, maxChars);
  return `${s.slice(0, maxChars - 20)}\n...[truncated]`;
}

/**
 * One search document per MCQ: sections + question + options + answer + explanation.
 * Priority: question/options/correct first; then Urdu; sections & explanation fill remaining budget.
 */
function buildEmbedText(row, maxChars = maxEmbedChars()) {
  const options = Array.isArray(row.options) ? row.options : [];
  const optionLines = options.map((opt) => `${opt.label}. ${opt.text}`);

  const coreParts = [];
  if (row.question_en) coreParts.push(`Question: ${row.question_en}`);
  if (optionLines.length) {
    coreParts.push("Options:");
    coreParts.push(...optionLines);
  }
  if (row.correct_label || row.correct_text) {
    const label = row.correct_label ? `${row.correct_label} ` : "";
    coreParts.push(`Correct: ${label}${row.correct_text || ""}`.trim());
  }

  let text = coreParts.join("\n").trim() || "empty mcq";
  if (text.length > maxChars) {
    return truncateToChars(text, maxChars);
  }

  const extras = [];
  if (row.question_ur) extras.push(`Question (Urdu): ${row.question_ur}`);
  if (row.section_titles) extras.push(`Section: ${row.section_titles}`);
  if (row.explanation) extras.push(`Explanation: ${row.explanation}`);

  for (const part of extras) {
    const next = `${text}\n${part}`;
    if (next.length > maxChars) {
      const room = maxChars - text.length - 1;
      if (room > 80) {
        text = `${text}\n${truncateToChars(part, room)}`;
      }
      break;
    }
    text = next;
  }

  return text;
}

/**
 * Rough token estimate (~4 chars/token) for progress / budget logging.
 */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function isInputTooLongError(err) {
  const msg = String(err?.message || err || "");
  return (
    err?.status === 400 &&
    (/maximum input length/i.test(msg) || /8192/i.test(msg))
  );
}

/**
 * POST batch embeddings to OpenRouter (OpenAI-compatible).
 * @param {string[]} inputs
 * @returns {Promise<{ embeddings: number[][], usage?: object, model: string }>}
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
          "HTTP-Referer":
            process.env.OPENROUTER_HTTP_REFERER || "https://github.com/mcq-scraper",
          "X-Title":
            process.env.OPENROUTER_APP_TITLE || "MCQ Scraper Embeddings",
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

      const sorted = [...data].sort((a, b) => a.index - b.index);
      const embeddings = sorted.map((d) => d.embedding);
      return { embeddings, usage: body.usage, model };
    } catch (e) {
      lastErr = e;
      // Don't retry non-retryable 400 (e.g. input too long) — caller handles fallback
      if (e.status === 400) break;
      const retryable =
        e.status === 429 ||
        e.status === 500 ||
        e.status === 502 ||
        e.status === 503 ||
        e.code === "ECONNRESET" ||
        e.name === "TypeError";
      if (!retryable || attempt === retries) break;
      const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      await sleep(backoff);
    }
  }

  throw lastErr;
}

/**
 * Embed one string; if still too long, shrink and retry once more.
 */
async function embedOneWithTruncate(text) {
  let current = text;
  let lastErr;
  for (const budget of [maxEmbedChars(), 16000, 8000, 4000]) {
    current = truncateToChars(current, budget);
    try {
      const result = await createEmbeddings([current], { retries: 2 });
      return { text: current, embedding: result.embeddings[0], usage: result.usage };
    } catch (e) {
      lastErr = e;
      if (!isInputTooLongError(e)) throw e;
    }
  }
  throw lastErr;
}

module.exports = {
  embedModel,
  embedBatchSize,
  embedMaxAttempts,
  maxEmbedChars,
  buildEmbedText,
  truncateToChars,
  estimateTokens,
  createEmbeddings,
  embedOneWithTruncate,
  isInputTooLongError,
  sleep,
};
