#!/usr/bin/env bun
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { parse } from 'csv-parse';

import { normaliseDoi } from '@retractcheck/doi';

interface CliOptions {
  input: string;
  output?: string;
  batchSize: number;
  updatedAt: number;
  useTransaction: boolean;
}

const DEFAULT_BATCH_SIZE = 25;
const MAX_RECOMMENDED_BATCH = 50;
const PROGRESS_INTERVAL = 5000;

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: Partial<CliOptions> = { batchSize: DEFAULT_BATCH_SIZE, useTransaction: true };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' && args[i + 1]) {
      opts.input = args[++i];
    } else if (arg === '--output' && args[i + 1]) {
      opts.output = args[++i];
    } else if (arg === '--batch-size' && args[i + 1]) {
      opts.batchSize = Number(args[++i]);
    } else if (arg === '--updated-at' && args[i + 1]) {
      opts.updatedAt = Number(args[++i]);
    } else if (arg === '--no-transaction') {
      opts.useTransaction = false;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!opts.input) {
    throw new Error('Missing required --input <file> argument');
  }

  if (!opts.updatedAt || !Number.isFinite(opts.updatedAt)) {
    opts.updatedAt = Math.floor(Date.now() / 1000);
  }

  if (!opts.batchSize || !Number.isFinite(opts.batchSize) || opts.batchSize < 1) {
    opts.batchSize = DEFAULT_BATCH_SIZE;
  }

  if (opts.batchSize > MAX_RECOMMENDED_BATCH) {
    console.warn(
      `Batch size ${opts.batchSize} may exceed D1 limits; large INSERT statements risk SQLITE_TOOBIG.`,
    );
  }

  return opts as CliOptions;
}

function sqlString(value: string | null | undefined): string {
  if (value == null || value === '') return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function createSqlWriter(path?: string): Promise<{ writable: Writable; close: () => Promise<void> }> {
  if (!path) {
    return {
      writable: process.stdout,
      close: async () => Promise.resolve(),
    };
  }

  const fileStream = createWriteStream(path, { encoding: 'utf8' });
  return {
    writable: fileStream,
    close: () =>
      new Promise<void>((resolve, reject) => {
        fileStream.end(() => resolve());
        fileStream.on('error', reject);
      }),
  };
}

async function writeChunk(writable: Writable, chunk: string): Promise<void> {
  if (writable.write(chunk)) return;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      writable.off('drain', onDrain);
      reject(err);
    };
    const onDrain = () => {
      writable.off('error', onError);
      resolve();
    };
    writable.once('error', onError);
    writable.once('drain', onDrain);
  });
}

async function main(): Promise<void> {
  const options = parseArgs();
  const { input, output, batchSize, updatedAt, useTransaction } = options;

  const { writable, close } = await createSqlWriter(output);

  const parser = parse({ columns: true, skip_empty_lines: true, bom: true });

  let processed = 0;
  let skipped = 0;
  const batch: string[] = [];
  let flushing = Promise.resolve();

  const flush = () => {
    if (!batch.length) {
      return flushing;
    }
    const values = batch.join(',\n  ');
    batch.length = 0;
    flushing = flushing.then(() =>
      writeChunk(
        writable,
        `INSERT OR REPLACE INTO entries (record_id, doi_norm_original, doi_norm_retraction, raw, updated_at)\nVALUES\n  ${values};\n`,
      ),
    );
    return flushing;
  };

  if (useTransaction) {
    await writeChunk(writable, 'BEGIN;\n');
  }

  const inputStream = createReadStream(input, { encoding: 'utf8' });

  await pipeline(
    inputStream,
    parser,
    new Writable({
      objectMode: true,
      write(record: Record<string, string>, _encoding, callback) {
        try {
          const rawRecord = { ...record };
          const idValue = Number(rawRecord['Record ID']);
          if (!Number.isFinite(idValue)) {
            skipped += 1;
            return callback();
          }

          const doiOriginal = normaliseDoi(rawRecord['OriginalPaperDOI']);
          const doiRetraction = normaliseDoi(rawRecord['RetractionDOI']);
          const rawJson = JSON.stringify(rawRecord);

          batch.push(`(${idValue}, ${sqlString(doiOriginal)}, ${sqlString(doiRetraction)}, ${sqlJson(rawJson)}, ${updatedAt})`);
          processed += 1;

          if (processed % PROGRESS_INTERVAL === 0) {
            console.error(`Processed ${processed} rows...`);
          }

          if (batch.length >= batchSize) {
            flush().then(() => callback(), callback);
          } else {
            callback();
          }
        } catch (error) {
          callback(error as Error);
        }
      },
      final(callback) {
        flush();
        flushing.then(() => callback(), callback);
      },
    }),
  );

  await flushing;
  if (useTransaction) {
    await writeChunk(writable, 'COMMIT;\n');
  }
  await close();

  console.error(`Processed rows: ${processed}`);
  if (skipped) {
    console.error(`Skipped rows (missing Record ID): ${skipped}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
