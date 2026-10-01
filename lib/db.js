const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { loadEnv } = require("./env");
const { stableSourceId } = require("./extractMcqs");

loadEnv();

let pool;

function buildPoolConfig(connectionString) {
  const config = { connectionString };
  // node-pg does not always honor sslmode= in the URL; enable SSL for RDS
  const needsSsl =
    /sslmode=(require|verify-full|verify-ca)/i.test(connectionString) ||
    /\.rds\.amazonaws\.com/i.test(connectionString);
  if (needsSsl) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set (see .env.example)");
    }
    if (url.includes("REPLACE_WITH_RDS_PASSWORD") || url.includes("YOUR_PASSWORD")) {
      throw new Error(
        "Set your real RDS password in .env DATABASE_URL (replace REPLACE_WITH_RDS_PASSWORD)"
      );
    }
    pool = new Pool(buildPoolConfig(url));
  }
  return pool;
}

async function ensureSchema() {
  const client = await getPool().connect();
  try {
    // Extension + column migrate MUST run before any index on embed_status.
    // Existing DBs already have mcqs without embed_* ; CREATE TABLE IF NOT EXISTS is a no-op.
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");
    await client.query(sql);

    await client.query(`
      ALTER TABLE mcq_sections
      ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    await client.query(`
      ALTER TABLE mcqs
        ADD COLUMN IF NOT EXISTS embed_text TEXT,
        ADD COLUMN IF NOT EXISTS embedding vector(1536),
        ADD COLUMN IF NOT EXISTS embedding_model TEXT,
        ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS embed_status VARCHAR(16) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS embed_error TEXT,
        ADD COLUMN IF NOT EXISTS embed_attempts INT NOT NULL DEFAULT 0
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mcqs_embed_pending
        ON mcqs (embed_status)
        WHERE embed_status IN ('pending', 'failed')
    `);
  } finally {
    client.release();
  }
}

async function upsertSection(section) {
  const r = await getPool().query(
    `INSERT INTO sections (kind, title, slug, url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       url = EXCLUDED.url,
       kind = EXCLUDED.kind
     RETURNING id`,
    [section.kind, section.title, section.slug, section.url]
  );
  return r.rows[0].id;
}

async function setSectionMaxPage(sectionId, maxPage) {
  await getPool().query(
    `UPDATE sections SET max_page = GREATEST(COALESCE(max_page, 0), $2) WHERE id = $1`,
    [sectionId, maxPage]
  );
}

async function ensurePageJobs(sectionId, maxPage) {
  for (let p = 1; p <= maxPage; p++) {
    await getPool().query(
      `INSERT INTO crawl_jobs (section_id, page_num, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (section_id, page_num) DO NOTHING`,
      [sectionId, p]
    );
  }
}

/** Crash recovery: pages left as "running" become pending again. */
async function resetStuckRunningJobs(sectionId = null) {
  if (sectionId == null) {
    await getPool().query(
      `UPDATE crawl_jobs SET status = 'pending'
       WHERE status = 'running'`
    );
  } else {
    await getPool().query(
      `UPDATE crawl_jobs SET status = 'pending'
       WHERE section_id = $1 AND status = 'running'`,
      [sectionId]
    );
  }
}

async function getPendingPages(sectionId, limit = 10000) {
  // Allow enough attempts across resumes; each markPageRunning increments.
  const maxAttempts = parseInt(process.env.MAX_PAGE_RETRIES || "8", 10);
  const r = await getPool().query(
    `SELECT page_num, attempts FROM crawl_jobs
     WHERE section_id = $1
       AND status IN ('pending', 'failed', 'running')
       AND attempts < $3
     ORDER BY page_num
     LIMIT $2`,
    [sectionId, limit, maxAttempts]
  );
  return r.rows;
}

async function markPageRunning(sectionId, pageNum) {
  await getPool().query(
    `UPDATE crawl_jobs SET status = 'running', attempts = attempts + 1
     WHERE section_id = $1 AND page_num = $2`,
    [sectionId, pageNum]
  );
}

async function markPageDone(sectionId, pageNum) {
  await getPool().query(
    `UPDATE crawl_jobs SET status = 'done', last_error = NULL, scraped_at = NOW()
     WHERE section_id = $1 AND page_num = $2`,
    [sectionId, pageNum]
  );
}

async function markPageFailed(sectionId, pageNum, errorMessage) {
  await getPool().query(
    `UPDATE crawl_jobs SET status = 'failed', last_error = $3
     WHERE section_id = $1 AND page_num = $2`,
    [sectionId, pageNum, errorMessage]
  );
}

/**
 * Upsert one MCQ by source_id (no duplicate rows).
 * If already exists: refresh text fields, then only link this section in mcq_sections.
 */
async function upsertMcq(mcq, sectionId) {
  const sourceId = stableSourceId(mcq);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT source_id FROM mcqs WHERE source_id = $1`,
      [sourceId]
    );
    const isNew = existing.rowCount === 0;

    await client.query(
      `INSERT INTO mcqs (source_id, question_en, question_ur, correct_label, correct_text, explanation, source_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (source_id) DO UPDATE SET
         question_en = COALESCE(EXCLUDED.question_en, mcqs.question_en),
         question_ur = COALESCE(EXCLUDED.question_ur, mcqs.question_ur),
         correct_label = COALESCE(EXCLUDED.correct_label, mcqs.correct_label),
         correct_text = COALESCE(EXCLUDED.correct_text, mcqs.correct_text),
         explanation = COALESCE(EXCLUDED.explanation, mcqs.explanation),
         source_url = COALESCE(EXCLUDED.source_url, mcqs.source_url),
         updated_at = NOW()`,
      [
        sourceId,
        mcq.questionEn,
        mcq.questionUr,
        mcq.correctLabel,
        mcq.correctAnswer,
        mcq.explanation,
        mcq.url,
      ]
    );

    await client.query(`DELETE FROM mcq_options WHERE mcq_id = $1`, [sourceId]);
    for (const opt of mcq.options || []) {
      await client.query(
        `INSERT INTO mcq_options (mcq_id, label, text) VALUES ($1, $2, $3)`,
        [sourceId, opt.label, opt.text]
      );
    }

    const link = await client.query(
      `INSERT INTO mcq_sections (mcq_id, section_id) VALUES ($1, $2)
       ON CONFLICT (mcq_id, section_id) DO NOTHING
       RETURNING mcq_id`,
      [sourceId, sectionId]
    );
    const sectionLinked = link.rowCount > 0;

    await client.query("COMMIT");
    return { sourceId, isNew, sectionLinked };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getSectionBySlug(slug) {
  const r = await getPool().query(`SELECT * FROM sections WHERE slug = $1`, [
    slug,
  ]);
  return r.rows[0] || null;
}

/** Per-section crawl progress for logging / resume visibility. */
async function getCrawlProgress() {
  const r = await getPool().query(`
    SELECT
      s.id,
      s.slug,
      s.title,
      s.kind,
      s.max_page,
      COUNT(j.*) FILTER (WHERE j.status = 'done')::int AS pages_done,
      COUNT(j.*) FILTER (WHERE j.status IN ('pending', 'failed', 'running'))::int AS pages_left,
      COUNT(j.*)::int AS pages_total,
      CASE
        WHEN COUNT(j.*) = 0 THEN 'not_started'
        WHEN COUNT(j.*) FILTER (WHERE j.status = 'done') = COUNT(j.*)
             AND COUNT(j.*) >= COALESCE(s.max_page, 0)
             AND COALESCE(s.max_page, 0) > 0 THEN 'complete'
        WHEN COUNT(j.*) FILTER (WHERE j.status = 'done') > 0 THEN 'partial'
        ELSE 'pending'
      END AS crawl_status
    FROM sections s
    LEFT JOIN crawl_jobs j ON j.section_id = s.id
    GROUP BY s.id
    ORDER BY s.kind, s.id
  `);
  return r.rows;
}

/**
 * Next batch of MCQs that still need embeddings (pending or failed, under max attempts).
 * Includes options and section titles for building embed_text.
 */
async function getPendingEmbedMcqs(limit = 64, maxAttempts = 5) {
  const r = await getPool().query(
    `
    SELECT
      m.source_id,
      m.question_en,
      m.question_ur,
      m.correct_label,
      m.correct_text,
      m.explanation,
      m.embed_attempts,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object('label', o.label, 'text', o.text)
            ORDER BY o.label
          )
          FROM mcq_options o
          WHERE o.mcq_id = m.source_id
        ),
        '[]'::json
      ) AS options,
      COALESCE(
        (
          SELECT string_agg(t.title, ' | ' ORDER BY t.title)
          FROM (
            SELECT DISTINCT s.title
            FROM mcq_sections ms
            JOIN sections s ON s.id = ms.section_id
            WHERE ms.mcq_id = m.source_id
          ) t
        ),
        ''
      ) AS section_titles
    FROM mcqs m
    WHERE m.embed_status IN ('pending', 'failed')
      AND m.embed_attempts < $2
    ORDER BY m.source_id
    LIMIT $1
    `,
    [limit, maxAttempts]
  );
  return r.rows;
}

async function markEmbedDone(sourceId, embedText, embedding, model) {
  // pgvector accepts the "[1,2,3]" text form
  const vectorLiteral = `[${embedding.join(",")}]`;
  await getPool().query(
    `UPDATE mcqs SET
       embed_text = $2,
       embedding = $3::vector,
       embedding_model = $4,
       embedded_at = NOW(),
       embed_status = 'done',
       embed_error = NULL,
       embed_attempts = embed_attempts + 1
     WHERE source_id = $1`,
    [sourceId, embedText, vectorLiteral, model]
  );
}

async function markEmbedFailed(sourceId, errorMessage) {
  await getPool().query(
    `UPDATE mcqs SET
       embed_status = 'failed',
       embed_error = $2,
       embed_attempts = embed_attempts + 1
     WHERE source_id = $1`,
    [sourceId, errorMessage]
  );
}

async function getEmbedProgress() {
  const r = await getPool().query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE embed_status = 'done')::int AS done,
      COUNT(*) FILTER (WHERE embed_status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE embed_status = 'failed')::int AS failed
    FROM mcqs
  `);
  return r.rows[0];
}

async function countRetryableEmbeds(maxAttempts = 5) {
  const r = await getPool().query(
    `SELECT COUNT(*)::int AS n
     FROM mcqs
     WHERE embed_status IN ('pending', 'failed')
       AND embed_attempts < $1`,
    [maxAttempts]
  );
  return r.rows[0].n;
}

/** Re-queue failed embeds so a code fix (e.g. truncation) can retry them. */
async function resetFailedEmbeds() {
  const r = await getPool().query(
    `UPDATE mcqs
     SET embed_status = 'pending',
         embed_attempts = 0,
         embed_error = NULL
     WHERE embed_status = 'failed'
     RETURNING source_id`
  );
  return r.rowCount;
}

async function closePool() {
  if (pool) await pool.end();
}

module.exports = {
  getPool,
  ensureSchema,
  upsertSection,
  setSectionMaxPage,
  ensurePageJobs,
  resetStuckRunningJobs,
  getPendingPages,
  markPageRunning,
  markPageDone,
  markPageFailed,
  upsertMcq,
  getSectionBySlug,
  getCrawlProgress,
  getPendingEmbedMcqs,
  markEmbedDone,
  markEmbedFailed,
  getEmbedProgress,
  countRetryableEmbeds,
  resetFailedEmbeds,
  closePool,
};
