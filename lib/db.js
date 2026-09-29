const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { loadEnv } = require("./env");
const { stableSourceId } = require("./extractMcqs");

loadEnv();

let pool;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set (see .env.example)");
    }
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

async function ensureSchema() {
  const client = await getPool().connect();
  try {
    const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");
    await client.query(sql);
    // Migrate older DBs that lack first_seen_at
    await client.query(`
      ALTER TABLE mcq_sections
      ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  const maxAttempts = parseInt(process.env.MAX_PAGE_RETRIES || "3", 10);
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
  closePool,
};
