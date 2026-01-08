import { normaliseDoi } from '@retractcheck/doi';
import type { D1Database, KVNamespace, RequestInit } from '@cloudflare/workers-types';

import type { Env } from './env';

type RawCsvRow = Record<string, string>;

/**
 * Healthchecks.io ping types
 * - 'start': Signal job has started (for duration tracking)
 * - 'success': Signal job completed successfully
 * - 'fail': Signal job failed
 */
type HealthcheckPingType = 'start' | 'success' | 'fail';

/**
 * Ping healthchecks.io endpoint
 * Sends a POST request with optional body data (stats, error message)
 * Fails silently to avoid breaking ingest if monitoring is down
 */
export async function pingHealthcheck(
  pingUrl: string | undefined,
  type: HealthcheckPingType,
  body?: string,
): Promise<boolean> {
  if (!pingUrl) return false;

  try {
    const url = type === 'success' ? pingUrl : `${pingUrl}/${type}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: body?.slice(0, 100_000), // Healthchecks.io limit is 100KB
    });
    return response.ok;
  } catch (error) {
    console.warn(`[healthcheck] Failed to ping (${type}):`, error);
    return false;
  }
}

export const ACTIVE_TABLE_KEY = 'ingest:active_table';
const SOURCE_URL_DEFAULT =
  'https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv';
const BATCH_SIZE = 250;
const TABLE_RETENTION_DAYS = 7;

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const RETRY_BACKOFF_MULTIPLIER = 2;

export interface IngestStats {
  fetchedBytes: number;
  processedRows: number;
  skippedRows: number;
  tableName: string;
  previousTable: string | null;
  healthChecks: HealthCheckResult;
  cleanedUpTables: string[];
}

export interface HealthCheckResult {
  passed: boolean;
  rowCount: number;
  previousRowCount: number | null;
  sampleLookupPassed: boolean;
  nullCheckPassed: boolean;
  indexesCreated: boolean;
  errors: string[];
}

/**
 * Generate a timestamped table name for versioning
 */
function generateTableName(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `entries_${timestamp}`;
}

/**
 * Parse table name to extract timestamp
 */
function parseTableTimestamp(tableName: string): Date | null {
  const match = tableName.match(/^entries_(\d{14})$/);
  if (!match) return null;
  const ts = match[1];
  const year = parseInt(ts.slice(0, 4));
  const month = parseInt(ts.slice(4, 6)) - 1;
  const day = parseInt(ts.slice(6, 8));
  const hour = parseInt(ts.slice(8, 10));
  const min = parseInt(ts.slice(10, 12));
  const sec = parseInt(ts.slice(12, 14));
  return new Date(year, month, day, hour, min, sec);
}

/**
 * Fetch with exponential backoff retry
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error | null = null;
  let delay = INITIAL_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Retry on 5xx server errors or 429 rate limit
      if (response.status >= 500 || response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          delay = parseInt(retryAfter, 10) * 1000 || delay;
        }
        throw new Error(`Server error (${response.status})`);
      }

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[ingest] Fetch attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);

      if (attempt < maxRetries) {
        console.log(`[ingest] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= RETRY_BACKOFF_MULTIPLIER;
      }
    }
  }

  throw new Error(`CSV fetch failed after ${maxRetries} attempts: ${lastError?.message}`);
}

/**
 * Main ingest function with blue-green deployment
 */
export async function runIngest(env: Env): Promise<IngestStats> {
  const sourceUrl = env.RETRACTCHECK_SOURCE_URL || SOURCE_URL_DEFAULT;
  const newTableName = generateTableName();

  console.log(`[ingest] Starting ingest to table: ${newTableName}`);

  // Get the currently active table for comparison
  const previousTable = await env.RETRACTCHECK_CACHE.get(ACTIVE_TABLE_KEY);
  console.log(`[ingest] Previous active table: ${previousTable || 'none'}`);

  // Step 1: Download CSV with retry
  const response = await fetchWithRetry(sourceUrl, {
    headers: { Accept: 'text/csv' },
  });

  if (!response.ok || !response.body) {
    throw new Error(`CSV fetch failed (${response.status})`);
  }

  // Step 2: Create new versioned table with indexes
  await createTable(env.RETRACTCHECK_DB, newTableName);
  console.log(`[ingest] Created table: ${newTableName}`);

  // Step 3: Stream and insert data
  const { processedRows, skippedRows, fetchedBytes } = await streamInsertData(
    env.RETRACTCHECK_DB,
    newTableName,
    response.body
  );
  console.log(`[ingest] Inserted ${processedRows} rows, skipped ${skippedRows} rows (${fetchedBytes} bytes)`);

  // Step 4: Create indexes after bulk insert (faster than during insert)
  const indexesCreated = await createIndexes(env.RETRACTCHECK_DB, newTableName);
  console.log(`[ingest] Indexes created: ${indexesCreated}`);

  // Step 5: Run health checks
  const healthChecks = await runHealthChecks(
    env.RETRACTCHECK_DB,
    newTableName,
    previousTable
  );
  console.log(`[ingest] Health checks: ${healthChecks.passed ? 'PASSED' : 'FAILED'}`, healthChecks);

  // Step 6: If health checks pass, update the active table pointer
  if (healthChecks.passed) {
    await env.RETRACTCHECK_CACHE.put(ACTIVE_TABLE_KEY, newTableName);
    console.log(`[ingest] Activated table: ${newTableName}`);

    // Also store metadata for API responses
    const metadata = {
      tableName: newTableName,
      rowCount: healthChecks.rowCount,
      updatedAt: new Date().toISOString(),
    };
    await env.RETRACTCHECK_CACHE.put('ingest:metadata', JSON.stringify(metadata));
  } else {
    // Health checks failed - drop the new table and keep using the old one
    console.error(`[ingest] Health checks failed, dropping table: ${newTableName}`);
    await dropTable(env.RETRACTCHECK_DB, newTableName);
    throw new Error(`Ingest health checks failed: ${healthChecks.errors.join(', ')}`);
  }

  // Step 7: Cleanup old tables
  const cleanedUpTables = await cleanupOldTables(
    env.RETRACTCHECK_DB,
    env.RETRACTCHECK_CACHE,
    newTableName
  );
  console.log(`[ingest] Cleaned up ${cleanedUpTables.length} old tables`);

  return {
    fetchedBytes,
    processedRows,
    skippedRows,
    tableName: newTableName,
    previousTable,
    healthChecks,
    cleanedUpTables,
  };
}

/**
 * Create a new entries table with the versioned name
 */
async function createTable(db: D1Database, tableName: string): Promise<void> {
  // Sanitize table name to prevent SQL injection (only allow alphanumeric and underscore)
  if (!/^entries_\d{14}$/.test(tableName)) {
    throw new Error(`Invalid table name format: ${tableName}`);
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      record_id INTEGER PRIMARY KEY,
      doi_norm_original TEXT,
      doi_norm_retraction TEXT,
      raw TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * Create indexes on the table (done after bulk insert for performance)
 */
async function createIndexes(db: D1Database, tableName: string): Promise<boolean> {
  if (!/^entries_\d{14}$/.test(tableName)) {
    throw new Error(`Invalid table name format: ${tableName}`);
  }

  try {
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${tableName.slice(8)}_doi_original
      ON ${tableName} (doi_norm_original)
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${tableName.slice(8)}_doi_retraction
      ON ${tableName} (doi_norm_retraction)
    `);
    return true;
  } catch (error) {
    console.error('[ingest] Failed to create indexes:', error);
    return false;
  }
}

/**
 * Drop a table (used for cleanup or failed ingests)
 */
async function dropTable(db: D1Database, tableName: string): Promise<void> {
  if (!/^entries_\d{14}$/.test(tableName)) {
    throw new Error(`Invalid table name format: ${tableName}`);
  }
  await db.exec(`DROP TABLE IF EXISTS ${tableName}`);
}

/**
 * Stream CSV data and insert into the database
 */
// Required fields for a valid CSV row
const REQUIRED_FIELDS = ['Record ID'];

/**
 * Validate a CSV row has required fields
 */
function validateRow(
  record: RawCsvRow,
  rowNumber: number,
): { valid: boolean; reason?: string } {
  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null || value.trim() === '') {
      return { valid: false, reason: `Missing required field: ${field}` };
    }
  }

  // Validate Record ID is a number
  const recordId = Number(record['Record ID']);
  if (!Number.isFinite(recordId) || recordId <= 0) {
    return { valid: false, reason: `Invalid Record ID: ${record['Record ID']}` };
  }

  // Check if at least one DOI is present (warn but don't skip)
  const hasOriginalDoi = record['OriginalPaperDOI']?.trim();
  const hasRetractionDoi = record['RetractionDOI']?.trim();
  if (!hasOriginalDoi && !hasRetractionDoi) {
    // Log warning but still valid - some records may not have DOIs yet
    if (rowNumber <= 5) { // Only log first few warnings to avoid spam
      console.warn(`[ingest] Row ${rowNumber}: No DOI found (Record ID: ${record['Record ID']})`);
    }
  }

  return { valid: true };
}

async function streamInsertData(
  db: D1Database,
  tableName: string,
  body: ReadableStream<Uint8Array>
): Promise<{ processedRows: number; skippedRows: number; fetchedBytes: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');

  let totalBytes = 0;
  let processedRows = 0;
  let skippedRows = 0;
  let rowNumber = 0;
  let columns: string[] | null = null;
  let currentRow = '';
  let inQuotes = false;
  let batch: { recordId: number; doiOriginal: string | null; doiRetraction: string | null; raw: string; updatedAt: number }[] = [];

  const flushBatch = async () => {
    if (!batch.length) return;

    const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(row => [
      row.recordId,
      row.doiOriginal,
      row.doiRetraction,
      row.raw,
      row.updatedAt
    ]);

    await db.prepare(
      `INSERT OR REPLACE INTO ${tableName}
       (record_id, doi_norm_original, doi_norm_retraction, raw, updated_at)
       VALUES ${placeholders}`
    ).bind(...values).run();

    batch = [];
  };

  const processRow = async (row: string) => {
    if (!row || !row.trim()) return;

    if (!columns) {
      columns = splitCsvLine(row);
      return;
    }

    rowNumber++;
    const cells = splitCsvLine(row);
    const record: RawCsvRow = {};
    for (let i = 0; i < columns.length; i++) {
      record[columns[i]] = cells[i] ?? '';
    }

    // Validate the row
    const validation = validateRow(record, rowNumber);
    if (!validation.valid) {
      skippedRows++;
      if (skippedRows <= 10) { // Log first 10 skipped rows
        console.warn(`[ingest] Skipping row ${rowNumber}: ${validation.reason}`);
      }
      return;
    }

    const recordId = Number(record['Record ID']);

    batch.push({
      recordId,
      doiOriginal: normaliseDoi(record['OriginalPaperDOI']),
      doiRetraction: normaliseDoi(record['RetractionDOI']),
      raw: JSON.stringify(record),
      updatedAt: Math.floor(Date.now() / 1000),
    });
    processedRows++;

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
    }
  };

  const processChunk = async (chunk: string, finalChunk = false) => {
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];

      if (char === '"') {
        if (inQuotes && chunk[i + 1] === '"') {
          currentRow += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        currentRow += '"';
        continue;
      }

      if (!inQuotes && (char === '\n' || char === '\r')) {
        if (char === '\r' && chunk[i + 1] === '\n') {
          i++;
        }
        await processRow(currentRow);
        currentRow = '';
        continue;
      }

      currentRow += char;
    }

    if (finalChunk && currentRow) {
      await processRow(currentRow);
      currentRow = '';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    const chunkText = decoder.decode(value, { stream: true });
    await processChunk(chunkText);
  }

  const remaining = decoder.decode(new Uint8Array(), { stream: false });
  if (remaining) {
    await processChunk(remaining, true);
  } else if (currentRow) {
    await processChunk('', true);
  }

  await flushBatch();

  if (skippedRows > 10) {
    console.warn(`[ingest] Total skipped rows: ${skippedRows} (only first 10 logged)`);
  }

  return { processedRows, skippedRows, fetchedBytes: totalBytes };
}

/**
 * Split a CSV line respecting quoted fields
 */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);
  return result.map((cell) => cell.trim());
}

/**
 * Run health checks on the newly created table
 */
async function runHealthChecks(
  db: D1Database,
  newTableName: string,
  previousTableName: string | null
): Promise<HealthCheckResult> {
  const errors: string[] = [];
  let rowCount = 0;
  let previousRowCount: number | null = null;
  let sampleLookupPassed = false;
  let nullCheckPassed = false;
  let indexesCreated = false;

  // Check 1: Row count > 0
  try {
    const countResult = await db.prepare(
      `SELECT COUNT(*) as count FROM ${newTableName}`
    ).first<{ count: number }>();
    rowCount = countResult?.count ?? 0;

    if (rowCount === 0) {
      errors.push('New table has 0 rows');
    }
  } catch (error) {
    errors.push(`Failed to count rows: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Check 2: Row count >= 80% of previous (if previous exists)
  if (previousTableName && /^entries_\d{14}$/.test(previousTableName)) {
    try {
      const prevCountResult = await db.prepare(
        `SELECT COUNT(*) as count FROM ${previousTableName}`
      ).first<{ count: number }>();
      previousRowCount = prevCountResult?.count ?? 0;

      if (previousRowCount > 0 && rowCount < previousRowCount * 0.8) {
        errors.push(
          `Row count dropped significantly: ${rowCount} vs previous ${previousRowCount} (${Math.round(rowCount / previousRowCount * 100)}%)`
        );
      }
    } catch (error) {
      // Previous table might not exist, that's okay
      console.warn('[ingest] Could not check previous table row count:', error);
    }
  }

  // Check 3: Sample DOI lookup works
  try {
    const sampleResult = await db.prepare(
      `SELECT record_id FROM ${newTableName}
       WHERE doi_norm_original IS NOT NULL
       LIMIT 1`
    ).first<{ record_id: number }>();
    sampleLookupPassed = sampleResult !== null;

    if (!sampleLookupPassed) {
      errors.push('Sample DOI lookup returned no results');
    }
  } catch (error) {
    errors.push(`Sample lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Check 4: Not too many NULL DOIs (at least 50% should have original DOI)
  try {
    const nullResult = await db.prepare(
      `SELECT COUNT(*) as count FROM ${newTableName}
       WHERE doi_norm_original IS NULL AND doi_norm_retraction IS NULL`
    ).first<{ count: number }>();
    const bothNullCount = nullResult?.count ?? 0;

    nullCheckPassed = rowCount === 0 || bothNullCount < rowCount * 0.5;

    if (!nullCheckPassed) {
      errors.push(`Too many rows with both DOIs null: ${bothNullCount}/${rowCount}`);
    }
  } catch (error) {
    errors.push(`NULL check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Check 5: Indexes exist
  try {
    const indexCheck = await db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='index' AND tbl_name = ?`
    ).bind(newTableName).all<{ name: string }>();

    indexesCreated = (indexCheck.results?.length ?? 0) >= 2;

    if (!indexesCreated) {
      errors.push('Required indexes not found');
    }
  } catch (error) {
    errors.push(`Index check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const passed = errors.length === 0 && rowCount > 0;

  return {
    passed,
    rowCount,
    previousRowCount,
    sampleLookupPassed,
    nullCheckPassed,
    indexesCreated,
    errors,
  };
}

/**
 * Cleanup old tables beyond retention period
 */
async function cleanupOldTables(
  db: D1Database,
  cache: KVNamespace,
  currentTableName: string
): Promise<string[]> {
  const cleanedUp: string[] = [];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - TABLE_RETENTION_DAYS);

  try {
    // List all entries_* tables
    const tables = await db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name LIKE 'entries_%'`
    ).all<{ name: string }>();

    for (const table of tables.results ?? []) {
      const tableName = table.name;

      // Never delete the current active table
      if (tableName === currentTableName) continue;

      // Parse timestamp and check if older than retention period
      const tableDate = parseTableTimestamp(tableName);
      if (tableDate && tableDate < cutoffDate) {
        console.log(`[ingest] Dropping old table: ${tableName}`);
        await dropTable(db, tableName);
        cleanedUp.push(tableName);
      }
    }
  } catch (error) {
    console.error('[ingest] Cleanup failed:', error);
  }

  return cleanedUp;
}

/**
 * Get the currently active table name from KV
 * Returns null if no table is active yet
 */
export async function getActiveTableName(cache: KVNamespace): Promise<string | null> {
  return cache.get(ACTIVE_TABLE_KEY);
}
