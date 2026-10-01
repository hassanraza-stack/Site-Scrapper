-- Progress: which section pages are done / pending / failed
CREATE TABLE IF NOT EXISTS sections (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(32) NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL UNIQUE,
  max_page INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (section, page). status: pending | running | done | failed
-- Resume: only pending/failed/running pages are crawled again; done is skipped.
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id SERIAL PRIMARY KEY,
  section_id INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  page_num INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  last_error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  scraped_at TIMESTAMPTZ,
  UNIQUE (section_id, page_num)
);

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_pending
  ON crawl_jobs (section_id, status)
  WHERE status IN ('pending', 'failed', 'running');

-- pgvector for semantic search embeddings (OpenAI text-embedding-3-small = 1536 dims)
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per unique question (TestPoint /mcqs/{id}/ or content hash). Never duplicated.
CREATE TABLE IF NOT EXISTS mcqs (
  source_id VARCHAR(64) PRIMARY KEY,
  question_en TEXT,
  question_ur TEXT,
  correct_label CHAR(1),
  correct_text TEXT,
  explanation TEXT,
  source_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embed_text TEXT,
  embedding vector(1536),
  embedding_model TEXT,
  embedded_at TIMESTAMPTZ,
  embed_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  embed_error TEXT,
  embed_attempts INT NOT NULL DEFAULT 0
);

-- Index created in ensureSchema after migrate (existing DBs lack embed_* until ALTER)
-- HNSW cosine index for semantic search (also created in ensureSchema):
-- CREATE INDEX IF NOT EXISTS idx_mcqs_embedding_hnsw
--   ON mcqs USING hnsw (embedding vector_cosine_ops)
--   WITH (m = 16, ef_construction = 64)
--   WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS mcq_options (
  mcq_id VARCHAR(64) NOT NULL REFERENCES mcqs(source_id) ON DELETE CASCADE,
  label CHAR(1) NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (mcq_id, label)
);

-- Many-to-many: same MCQ can appear in many nav sections / papers.
-- Re-seeing a question only INSERT ON CONFLICT DO NOTHING here — no second mcqs row.
CREATE TABLE IF NOT EXISTS mcq_sections (
  mcq_id VARCHAR(64) NOT NULL REFERENCES mcqs(source_id) ON DELETE CASCADE,
  section_id INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (mcq_id, section_id)
);

CREATE INDEX IF NOT EXISTS idx_mcq_sections_section ON mcq_sections (section_id);
