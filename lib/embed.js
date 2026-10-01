/**
 * Build embed documents and call OpenRouter embeddings API.
 * Model: openai/text-embedding-3-small (1536 dims) by default.
 * Per-input hard limit is 8192 tokens. Non-Latin (Urdu) can be ~1 token/char,
 * so char budget must stay under ~8000 — NOT ~28k (that was English-only math).
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";

/** Model max tokens per input */
const MODEL_MAX_TOKENS = 8192;
/** Stay under limit even if ~1 char ≈ 1 token (Urdu/Arabic worst case) */
const DEFAULT_MAX_CHARS = 7500;

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
 * Clamp any string so it cannot exceed the model token limit in worst-case
 * tokenization (~1 char/token). Always call before API.
 */
function clampForModel(text) {
  return truncateToChars(text, maxEmbedChars());
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

  return clampForModel(text);
}

/**
 * Conservative token estimate for logging (assume denser multilingual text).
 */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 2.5));
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
 * Every input is clamped before send.
 * @param {string[]} inputs
 * @returns {Promise<{ embeddings: number[][], usage?: object, model: string }>}
 */
async function createEmbeddings(inputs, { retries = 3 } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set (see .env.example)");
  }
  const model = embedModel();
  const safeInputs = inputs.map((t) => clampForModel(t));
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
        body: JSON.stringify({ model, input: safeInputs }),
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
      if (!Array.isArray(data) || data.length !== safeInputs.length) {
        throw new Error(
          `Unexpected embeddings response: got ${data?.length ?? 0} vectors for ${safeInputs.length} inputs`
        );
      }

      const sorted = [...data].sort((a, b) => a.index - b.index);
      const embeddings = sorted.map((d) => d.embedding);
      return { embeddings, usage: body.usage, model, inputs: safeInputs };
    } catch (e) {
      lastErr = e;
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
 * Embed one string; if still too long, shrink and retry with smaller budgets.
 */
async function embedOneWithTruncate(text) {
  let current = clampForModel(text);
  let lastErr;
  // Budgets always ≤ DEFAULT_MAX_CHARS / model-safe sizes
  const budgets = [
    maxEmbedChars(),
    Math.min(5000, maxEmbedChars()),
    3000,
    1500,
    800,
  ];
  for (const budget of budgets) {
    current = truncateToChars(current, budget);
    try {
      const result = await createEmbeddings([current], { retries: 2 });
      return {
        text: result.inputs?.[0] || current,
        embedding: result.embeddings[0],
        usage: result.usage,
      };
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
  MODEL_MAX_TOKENS,
  buildEmbedText,
  truncateToChars,
  clampForModel,
  estimateTokens,
  createEmbeddings,
  embedOneWithTruncate,
  isInputTooLongError,
  sleep,
};
