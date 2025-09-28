import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

export interface Env {
  RETRACTCHECK_DB: D1Database;
  RETRACTCHECK_CACHE: KVNamespace;
  API_VERSION: string;
  RETRACTCHECK_SOURCE_URL?: string;
  INGEST_TOKEN?: string;
  RATE_LIMIT_CONFIG?: string;
}
