import { normaliseDoi } from '@retractcheck/doi';
import type { D1PreparedStatement } from '@cloudflare/workers-types';

import type { Env } from './env';

type RawCsvRow = Record<string, string>;

type IngestMetadata = {
  checksum: string;
  updatedAt: string;
};

const SOURCE_URL_DEFAULT =
  'https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv';
const METADATA_KEY = 'ingest:metadata';
const CACHE_KEY = 'ingest:checksum';
const BATCH_SIZE = 250;

export interface IngestStats {
  fetchedBytes: number;
  processedRows: number;
  skipped: boolean;
}

export async function runIngest(env: Env): Promise<IngestStats> {
  const sourceUrl = env.RETRACTCHECK_SOURCE_URL || SOURCE_URL_DEFAULT;
  const response = await fetch(sourceUrl, {
    headers: { Accept: 'text/csv' },
  });

  if (!response.ok || !response.body) {
    throw new Error(`CSV fetch failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  let processedRows = 0;
  let columns: string[] | null = null;
  let currentRow = '';
  let inQuotes = false;
  let statements: D1PreparedStatement[] = [];

  const flush = async () => {
    if (!statements.length) return;
    await env.RETRACTCHECK_DB.batch(statements);
    statements = [];
    if (typeof scheduler?.wait === 'function') {
      await scheduler.wait(0);
    }
  };

  const processRow = async (row: string) => {
    if (!row || !row.trim()) return;

    if (!columns) {
      columns = splitCsvLine(row);
      return;
    }

    const cells = splitCsvLine(row);
    const record: RawCsvRow = {};
    for (let i = 0; i < columns.length; i++) {
      record[columns[i]] = cells[i] ?? '';
    }

    const stmt = toPreparedStatement(env, record);
    if (!stmt) return;

    statements.push(stmt);
    processedRows++;

    if (statements.length >= BATCH_SIZE) {
      await flush();
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

    chunks.push(value);
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

  await flush();

  const bytes = concatenateChunks(chunks, totalBytes);
  const checksum = await digestHex(bytes);
  const previousChecksum = await env.RETRACTCHECK_CACHE.get(CACHE_KEY);
  if (previousChecksum === checksum) {
    return { fetchedBytes: totalBytes, processedRows: 0, skipped: true };
  }

  const metadata: IngestMetadata = {
    checksum,
    updatedAt: new Date().toISOString(),
  };

  await Promise.all([
    env.RETRACTCHECK_CACHE.put(CACHE_KEY, checksum),
    env.RETRACTCHECK_CACHE.put(METADATA_KEY, JSON.stringify(metadata)),
  ]);

  return {
    fetchedBytes: totalBytes,
    processedRows,
    skipped: false,
  };
}

function concatenateChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

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

function toPreparedStatement(env: Env, row: RawCsvRow): D1PreparedStatement | null {
  const recordId = Number(row['Record ID']);
  if (!Number.isFinite(recordId)) return null;

  const doiOriginal = normaliseDoi(row['OriginalPaperDOI']);
  const doiRetraction = normaliseDoi(row['RetractionDOI']);
  const raw = JSON.stringify(row);
  const updatedAt = Math.floor(Date.now() / 1000);

  return env.RETRACTCHECK_DB
    .prepare(
      `INSERT OR REPLACE INTO entries
       (record_id, doi_norm_original, doi_norm_retraction, raw, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      recordId,
      doiOriginal || null,
      doiRetraction || null,
      raw,
      updatedAt,
    );
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
