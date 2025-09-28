-- Migration number: 0001 	 2025-09-25T18:40:08.194Z

CREATE TABLE IF NOT EXISTS entries (
  record_id INTEGER PRIMARY KEY,
  doi_norm_original TEXT,
  doi_norm_retraction TEXT,
  raw TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_doi_original
  ON entries(doi_norm_original);

CREATE INDEX IF NOT EXISTS idx_entries_doi_retraction
  ON entries(doi_norm_retraction);
