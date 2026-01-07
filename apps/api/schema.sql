-- RetractCheck D1 Database Schema
-- Stores retraction records from Retraction Watch database

CREATE TABLE IF NOT EXISTS entries (
  record_id INTEGER PRIMARY KEY,
  doi_norm_original TEXT,
  doi_norm_retraction TEXT,
  raw TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_doi_original ON entries(doi_norm_original);
CREATE INDEX IF NOT EXISTS idx_doi_retraction ON entries(doi_norm_retraction);
CREATE INDEX IF NOT EXISTS idx_updated_at ON entries(updated_at);