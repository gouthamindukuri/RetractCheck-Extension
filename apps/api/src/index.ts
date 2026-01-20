import type {
  ExecutionContext,
  ExportedHandler,
  KVNamespace,
  ScheduledController,
} from '@cloudflare/workers-types';
import { normaliseDoi } from '@retractcheck/doi';
import type { RetractionStatusResponse } from '@retractcheck/types';

import type { Env } from './env';
import { runIngest, getActiveTableName, pingHealthcheck } from './ingest';

type RetractionRow = {
  record_id: number;
  raw: string;
  updated_at: number;
};

type IngestMetadata = {
  tableName: string;
  rowCount: number;
  updatedAt: string;
};

// Legacy table name for backward compatibility during migration
const LEGACY_TABLE_NAME = 'entries';

const CACHE_TTL = 12 * 60 * 60; // 12h seconds
const STALENESS_THRESHOLD_HOURS = 26; // Data older than this is considered stale (24h cron + 2h grace)
const METADATA_KEY = 'ingest:metadata';
const QUOTA_PREFIX = 'quota';
const RATE_LIMIT_ALLOW_HEADERS = 'Content-Type, X-RetractCheck-Client';

// Input validation limits to prevent abuse and KV pollution
const MAX_CLIENT_ID_LENGTH = 64;
const MAX_DOI_LENGTH = 500;
const MAX_HOST_LENGTH = 255;
const MAX_URL_LENGTH = 2048;
const MAX_OVERRIDE_BODY_SIZE = 10_000; // 10KB max for override requests

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
  'Access-Control-Allow-Headers': RATE_LIMIT_ALLOW_HEADERS,
} as const;

function jsonErrorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Always compares all characters regardless of where a mismatch occurs.
 */
function secureCompare(a: string, b: string): boolean {
  // Length difference is already a timing leak, but we still do the full comparison
  // to avoid additional timing information from early returns
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length !== b.length ? 1 : 0;

  for (let i = 0; i < maxLen; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= charA ^ charB;
  }

  return diff === 0;
}

type RateLimitType = 'status' | 'override';
type RateLimitScope = 'client' | 'ip';

interface RateLimitEntry {
  limit: number;
  windowSeconds: number;
  ipLimit?: number;
}

interface RateLimitConfig {
  status: RateLimitEntry;
  override: RateLimitEntry;
}

// Rate limits per minute
// Extension users (identified by UUID in X-RetractCheck-Client): 50/min
// Anonymous users: 10/min
const EXTENSION_RATE_LIMITS: RateLimitConfig = {
  status: {
    limit: 50,
    windowSeconds: 60,
    ipLimit: 100, // IP limit slightly higher to allow multiple clients behind NAT
  },
  override: {
    limit: 5,
    windowSeconds: 60,
    ipLimit: 10,
  },
};

const ANONYMOUS_RATE_LIMITS: RateLimitConfig = {
  status: {
    limit: 10,
    windowSeconds: 60,
    ipLimit: 20,
  },
  override: {
    limit: 2,
    windowSeconds: 60,
    ipLimit: 5,
  },
};

// UUID v4 pattern to identify extension clients
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OVERRIDE_KEY_PREFIX = 'override:';
const OVERRIDE_TTL_SECONDS = 60 * 60 * 24 * 90;

function buildResponse(body: RetractionStatusResponse): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      ...CORS_HEADERS,
    },
  });
}

async function fromCache(
  cache: KVNamespace,
  key: string,
): Promise<RetractionStatusResponse | null> {
  const raw = await cache.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RetractionStatusResponse;
  } catch {
    return null;
  }
}

async function toCache(
  cache: KVNamespace,
  key: string,
  value: RetractionStatusResponse,
): Promise<void> {
  await cache.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL });
}

async function fetchStatus(env: Env, doi: string): Promise<RetractionStatusResponse> {
  const cacheKey = `status:${doi}`;

  const cached = await fromCache(env.RETRACTCHECK_CACHE, cacheKey);
  if (cached) return cached;

  // Get the currently active table from KV (with fallback for migration)
  const activeTable = await getActiveTableName(env.RETRACTCHECK_CACHE);
  const tableName = activeTable || LEGACY_TABLE_NAME;

  // Validate table name format to prevent SQL injection
  if (!/^entries(_\d{14})?$/.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }

  const stmt = env.RETRACTCHECK_DB.prepare(
    `SELECT record_id, raw, updated_at FROM ${tableName} WHERE doi_norm_original = ? OR doi_norm_retraction = ?`
  );
  const rows = await stmt.bind(doi, doi).all<RetractionRow>();

  const metadataRaw = await env.RETRACTCHECK_CACHE.get(METADATA_KEY);
  const metadata = metadataRaw ? (JSON.parse(metadataRaw) as IngestMetadata) : null;

  const response: RetractionStatusResponse = {
    doi,
    meta: {
      datasetVersion: metadata?.tableName,
      updatedAt: metadata?.updatedAt,
    },
    records: rows.results.map((row) => ({
      recordId: row.record_id,
      raw: JSON.parse(row.raw) as Record<string, string>,
      updatedAt: row.updated_at,
    })),
  };

  await toCache(env.RETRACTCHECK_CACHE, cacheKey, response);
  return response;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/v1/ingest") {
      if (request.method !== "POST") {
        return jsonErrorResponse("Method Not Allowed", 405);
      }

      if (!env.INGEST_TOKEN) {
        return jsonErrorResponse("Ingest disabled", 403);
      }

      const authHeader = request.headers.get("authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      if (!token || !secureCompare(token, env.INGEST_TOKEN)) {
        return jsonErrorResponse("Unauthorized", 401);
      }

      try {
        const stats = await runIngest(env);
        return new Response(JSON.stringify({ ok: true, stats }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (url.pathname === "/v1/override") {
      if (request.method === "OPTIONS") return handleOptions();
      if (request.method !== "POST") {
        return jsonErrorResponse("Method Not Allowed", 405);
      }

      // Check request body size before parsing
      const contentLength = request.headers.get('Content-Length');
      if (contentLength && parseInt(contentLength, 10) > MAX_OVERRIDE_BODY_SIZE) {
        return jsonErrorResponse("Request body too large", 413);
      }

      try {
        const body = (await request.json()) as Record<string, unknown>;

        // Validate and truncate fields to prevent abuse
        const host = typeof body.host === 'string'
          ? body.host.toLowerCase().slice(0, MAX_HOST_LENGTH)
          : null;
        const doi = typeof body.doi === 'string'
          ? body.doi.trim().toLowerCase().slice(0, MAX_DOI_LENGTH)
          : undefined;
        const targetUrl = typeof body.url === 'string'
          ? body.url.slice(0, MAX_URL_LENGTH)
          : undefined;

        if (!host) {
          return new Response(JSON.stringify({ ok: false, error: 'Invalid host' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...CORS_HEADERS,
            },
          });
        }

        const clientId = normalizeClientId(request.headers.get('X-RetractCheck-Client'));
        const rateConfig = getRateLimitConfig(env, clientId);
        const ip = getRequestIp(request);
        const quota = await enforceQuota(env.RETRACTCHECK_CACHE, rateConfig.override, 'override', clientId, ip);
        if (!quota.ok) {
          return quotaExceededResponse('override', quota);
        }

        const event = {
          host,
          url: targetUrl,
          doi,
          triggeredAt: new Date().toISOString(),
          userAgent: request.headers.get('User-Agent') || undefined,
          clientId,
        } satisfies OverrideEvent;

        await storeOverrideEvent(env.RETRACTCHECK_CACHE, event);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        });
      } catch (error) {
        console.error('[override] failed', error);
        return new Response(JSON.stringify({ ok: false, error: 'Unable to record override' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        });
      }
    }

    if (request.method === "OPTIONS") return handleOptions();
    if (request.method !== "GET") {
      return jsonErrorResponse("Method Not Allowed", 405);
    }

    if (url.pathname === "/v1/health") {
      const activeTable = await getActiveTableName(env.RETRACTCHECK_CACHE);
      return new Response(JSON.stringify({
        ok: true,
        activeTable: activeTable || LEGACY_TABLE_NAME,
        usingLegacy: !activeTable,
      }), {
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }

    if (url.pathname === "/v1/info") {
      const metadataRaw = await env.RETRACTCHECK_CACHE.get(METADATA_KEY);
      const metadata = metadataRaw ? (JSON.parse(metadataRaw) as IngestMetadata) : null;

      // Calculate staleness
      let stale = true; // Assume stale if no metadata
      let dataAgeHours: number | null = null;
      if (metadata?.updatedAt) {
        const updatedAt = new Date(metadata.updatedAt);
        const ageMs = Date.now() - updatedAt.getTime();
        dataAgeHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10; // Round to 1 decimal
        stale = dataAgeHours > STALENESS_THRESHOLD_HOURS;
      }

      // Public info response - excludes internal table names and architecture details
      const responseBody = {
        ok: !stale,
        stale,
        dataAgeHours,
        rowCount: metadata?.rowCount ?? null,
        updatedAt: metadata?.updatedAt ?? null,
      };

      // Return 503 if stale so external monitors can detect it
      return new Response(JSON.stringify(responseBody), {
        status: stale ? 503 : 200,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
          // Cache for 5 minutes to avoid hammering the endpoint
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    if (url.pathname === "/v1/status") {
      const raw = url.searchParams.get("doi");

      // Reject excessively long DOI values
      if (raw && raw.length > MAX_DOI_LENGTH) {
        return jsonErrorResponse("DOI too long", 400);
      }

      const doi = normaliseDoi(raw);
      if (!raw || !doi) {
        return buildResponse({ doi: raw ?? '', meta: {}, records: [] });
      }

      const clientId = normalizeClientId(request.headers.get('X-RetractCheck-Client'));
      const rateConfig = getRateLimitConfig(env, clientId);
      const ip = getRequestIp(request);
      const quota = await enforceQuota(env.RETRACTCHECK_CACHE, rateConfig.status, 'status', clientId, ip);
      if (!quota.ok) {
        return quotaExceededResponse('status', quota);
      }

      try {
        const status = await fetchStatus(env, doi);
        return buildResponse(status);
      } catch (err) {
        console.error("status lookup failed", err);
        return jsonErrorResponse("Internal Error", 500);
      }
    }

    return jsonErrorResponse("Not Found", 404);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(handleCron(controller, env));
  },
} satisfies ExportedHandler<Env>;

function getRateLimitConfig(env: Env, clientId: string): RateLimitConfig {
  // Allow environment override for custom limits
  if (env.RATE_LIMIT_CONFIG) {
    try {
      const parsed = JSON.parse(env.RATE_LIMIT_CONFIG) as RateLimitConfig;
      if (parsed?.status?.limit && parsed?.override?.limit) {
        return parsed;
      }
    } catch {
      // ignore malformed overrides
    }
  }

  // Extension users (identified by UUID) get higher limits
  if (UUID_PATTERN.test(clientId)) {
    return EXTENSION_RATE_LIMITS;
  }

  // Anonymous users get lower limits
  return ANONYMOUS_RATE_LIMITS;
}

function normalizeClientId(value: string | null): string {
  if (!value) return 'anon';
  const trimmed = value.trim();
  if (!trimmed) return 'anon';
  // Truncate to prevent KV key pollution from malicious long values
  return trimmed.slice(0, MAX_CLIENT_ID_LENGTH);
}

/**
 * Basic IP address validation (IPv4 and IPv6)
 * This is intentionally permissive to handle various formats
 */
function isValidIpAddress(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed || trimmed.length > 45) return false; // Max IPv6 length

  // IPv4: simple pattern check (digits and dots)
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Pattern.test(trimmed)) {
    // Verify each octet is 0-255
    const octets = trimmed.split('.');
    return octets.every(o => {
      const n = parseInt(o, 10);
      return n >= 0 && n <= 255;
    });
  }

  // IPv6: contains colons and valid hex characters
  const ipv6Pattern = /^[a-fA-F0-9:]+$/;
  if (ipv6Pattern.test(trimmed) && trimmed.includes(':')) {
    return true;
  }

  // IPv6 with zone ID (e.g., fe80::1%eth0)
  if (trimmed.includes('%')) {
    const [addr] = trimmed.split('%');
    return /^[a-fA-F0-9:]+$/.test(addr) && addr.includes(':');
  }

  return false;
}

/**
 * Extract client IP from request headers with proper validation.
 *
 * Priority:
 * 1. CF-Connecting-IP (set by Cloudflare, trusted)
 * 2. True-Client-IP (set by Cloudflare, trusted)
 * 3. X-Forwarded-For (can be spoofed, requires validation)
 *
 * For X-Forwarded-For, we take the first (leftmost) IP as it represents
 * the original client. This header format is: "client, proxy1, proxy2"
 */
function getRequestIp(request: Request): string {
  // CF-Connecting-IP is set by Cloudflare and cannot be spoofed
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp && isValidIpAddress(cfIp)) {
    return cfIp.trim();
  }

  // True-Client-IP is also set by Cloudflare (Enterprise feature)
  const trueClientIp = request.headers.get('True-Client-IP');
  if (trueClientIp && isValidIpAddress(trueClientIp)) {
    return trueClientIp.trim();
  }

  // X-Forwarded-For can be spoofed, but useful for local dev
  // Format: "client, proxy1, proxy2" - take the first IP only
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) {
    const firstIp = xff.split(',')[0]?.trim();
    if (firstIp && isValidIpAddress(firstIp)) {
      return firstIp;
    }
  }

  return 'unknown';
}

type QuotaResult = { ok: true } | { ok: false; retryAfterSeconds: number; scope: RateLimitScope };

async function enforceQuota(
  cache: KVNamespace,
  config: RateLimitEntry,
  type: RateLimitType,
  clientId: string,
  ip: string,
): Promise<QuotaResult> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowSeconds = config.windowSeconds;
  const bucketStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;

  const clientKey = `${QUOTA_PREFIX}:${type}:client:${clientId}:${bucketStart}`;
  const clientResult = await incrementCounter(cache, clientKey, config.limit, windowSeconds, bucketStart, nowSeconds);
  if (!clientResult.allowed) {
    return { ok: false, retryAfterSeconds: clientResult.retryAfterSeconds, scope: 'client' };
  }

  if (config.ipLimit) {
    const ipKey = `${QUOTA_PREFIX}:${type}:ip:${ip}:${bucketStart}`;
    const ipResult = await incrementCounter(cache, ipKey, config.ipLimit, windowSeconds, bucketStart, nowSeconds);
    if (!ipResult.allowed) {
      return { ok: false, retryAfterSeconds: ipResult.retryAfterSeconds, scope: 'ip' };
    }
  }

  return { ok: true };
}

/**
 * Increment a rate limit counter in KV storage.
 *
 * NOTE: This implementation has a race condition - concurrent requests may both
 * pass the limit check before either writes. This is acceptable because:
 * 1. Rate limits here are soft protection for public data, not security-critical
 * 2. KV doesn't support atomic increment operations
 * 3. The window is short (60s), so any overage is minimal and temporary
 * 4. For strict rate limiting, use Cloudflare's built-in rate limiting product
 */
async function incrementCounter(
  cache: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
  bucketStart: number,
  nowSeconds: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const raw = await cache.get(key);
  const current = raw ? Number(raw) : 0;
  const bucketEnd = bucketStart + windowSeconds;
  const retryAfterSeconds = Math.max(1, bucketEnd - nowSeconds);

  if (Number.isFinite(current) && current >= limit) {
    return { allowed: false, retryAfterSeconds };
  }

  const next = Number.isFinite(current) ? current + 1 : 1;
  await cache.put(key, String(next), { expirationTtl: windowSeconds });
  return { allowed: true, retryAfterSeconds };
}

const RATE_LIMIT_RESPONSE_MESSAGES: Record<RateLimitType, string> = {
  status: 'Rate limit reached. Please wait before trying again.',
  override: 'Override rate limit reached. Please wait before trying again.',
};

function quotaExceededResponse(type: RateLimitType, result: Extract<QuotaResult, { ok: false }>): Response {
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterSeconds));
  return new Response(
    JSON.stringify({
      ok: false,
      error: RATE_LIMIT_RESPONSE_MESSAGES[type],
      type,
      scope: result.scope,
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
        'Retry-After': String(retryAfter),
      },
    },
  );
}

async function handleCron(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const pingUrl = env.HEALTHCHECK_PING_URL;

  // Signal start of ingest (for duration tracking)
  await pingHealthcheck(pingUrl, 'start');

  try {
    const stats = await runIngest(env);
    console.log('[ingest] complete', stats);

    // Signal successful completion with stats summary
    const summary = [
      `Ingest completed successfully`,
      `Table: ${stats.tableName}`,
      `Rows: ${stats.processedRows} processed, ${stats.skippedRows} skipped`,
      `Health checks: ${stats.healthChecks.passed ? 'PASSED' : 'FAILED'}`,
      `Row count: ${stats.healthChecks.rowCount}`,
      stats.previousTable ? `Previous: ${stats.previousTable}` : null,
      stats.cleanedUpTables.length > 0 ? `Cleaned up: ${stats.cleanedUpTables.join(', ')}` : null,
    ].filter(Boolean).join('\n');

    await pingHealthcheck(pingUrl, 'success', summary);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    console.error('[ingest] failed', err);

    // Signal failure with error details
    const failureReport = [
      `Ingest failed`,
      `Error: ${errorMessage}`,
      errorStack ? `Stack: ${errorStack}` : null,
    ].filter(Boolean).join('\n');

    await pingHealthcheck(pingUrl, 'fail', failureReport);

    // Re-throw to ensure Cloudflare logs the error
    throw err;
  }
}

type OverrideEvent = {
  host: string;
  url?: string;
  doi?: string;
  triggeredAt: string;
  userAgent?: string;
  clientId?: string;
};

async function storeOverrideEvent(cache: KVNamespace, event: OverrideEvent): Promise<void> {
  const key = `${OVERRIDE_KEY_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
  await cache.put(key, JSON.stringify(event), { expirationTtl: OVERRIDE_TTL_SECONDS });
}
