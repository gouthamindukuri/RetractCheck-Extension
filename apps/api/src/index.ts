import type {
  ExecutionContext,
  ExportedHandler,
  KVNamespace,
  ScheduledController,
} from '@cloudflare/workers-types';
import { normaliseDoi } from '@retractcheck/doi/normalize';
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

const CACHE_TTL = 12 * 60 * 60; // 12 hours
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
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST',
  'Access-Control-Allow-Headers': RATE_LIMIT_ALLOW_HEADERS,
} as const;

// Security headers
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
} as const;

// Combined standard headers for all responses
const STANDARD_HEADERS = {
  ...CORS_HEADERS,
  ...SECURITY_HEADERS,
} as const;

function jsonErrorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...STANDARD_HEADERS,
    },
  });
}

/**
 * 405 Method Not Allowed response with required Allow header per RFC 7231 §6.5.5
 */
function methodNotAllowedResponse(allowedMethods: string[]): Response {
  return new Response(JSON.stringify({ ok: false, error: 'Method Not Allowed' }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json',
      'Allow': allowedMethods.join(', '),
      ...STANDARD_HEADERS,
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

/**
 * Build a JSON response, supporting both GET and HEAD methods.
 * HEAD returns same headers but empty body per HTTP spec.
 */
function buildResponse(
  body: RetractionStatusResponse,
  isHead = false,
  extraHeaders: Record<string, string> = {}
): Response {
  const jsonBody = JSON.stringify(body);
  return new Response(isHead ? null : jsonBody, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(new TextEncoder().encode(jsonBody).length),
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      ...STANDARD_HEADERS,
      ...extraHeaders,
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
  let metadata: IngestMetadata | null = null;
  if (metadataRaw) {
    try {
      metadata = JSON.parse(metadataRaw) as IngestMetadata;
    } catch {
      console.warn('[status] Failed to parse metadata from cache');
    }
  }

  const response: RetractionStatusResponse = {
    doi,
    meta: {
      datasetVersion: metadata?.tableName,
      updatedAt: metadata?.updatedAt,
    },
    records: rows.results.flatMap((row) => {
      try {
        return [{
          recordId: row.record_id,
          raw: JSON.parse(row.raw) as Record<string, string>,
          updatedAt: row.updated_at,
        }];
      } catch {
        console.warn(`[status] Failed to parse raw JSON for record ${row.record_id}`);
        return []; // Skip malformed records
      }
    }),
  };

  await toCache(env.RETRACTCHECK_CACHE, cacheKey, response);
  return response;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: STANDARD_HEADERS,
  });
}

/**
 * Build a JSON response with optional HEAD support.
 * HEAD returns same headers but empty body per HTTP spec.
 */
function jsonResponse(
  body: Record<string, unknown>,
  options: { status?: number; headers?: Record<string, string>; isHead?: boolean } = {}
): Response {
  const { status = 200, headers = {}, isHead = false } = options;
  const jsonBody = JSON.stringify(body);
  return new Response(isHead ? null : jsonBody, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(jsonBody).length),
      ...STANDARD_HEADERS,
      ...headers,
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/v1/ingest") {
      if (request.method === "OPTIONS") return handleOptions();
      if (request.method !== "POST") {
        return methodNotAllowedResponse(['POST', 'OPTIONS']);
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
          status: 201,
          headers: {
            "Content-Type": "application/json",
            ...STANDARD_HEADERS,
          },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...STANDARD_HEADERS,
            },
          },
        );
      }
    }

    if (url.pathname === "/v1/override") {
      if (request.method === "OPTIONS") return handleOptions();
      if (request.method !== "POST") {
        return methodNotAllowedResponse(['POST', 'OPTIONS']);
      }

      // Check request body size before parsing
      const contentLength = request.headers.get('Content-Length');
      if (contentLength && parseInt(contentLength, 10) > MAX_OVERRIDE_BODY_SIZE) {
        return jsonErrorResponse("Request body too large", 413);
      }

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonErrorResponse("Invalid JSON body", 400);
      }

      try {
        // Validate and truncate fields to prevent abuse
        const host = typeof body.host === 'string'
          ? body.host.toLowerCase().slice(0, MAX_HOST_LENGTH)
          : null;
        const doi = typeof body.doi === 'string'
          ? body.doi.trim().toLowerCase().slice(0, MAX_DOI_LENGTH)
          : undefined;

        // Strip query params and fragments from URL to avoid storing session tokens or PII
        let sanitizedUrl: string | undefined;
        if (typeof body.url === 'string') {
          try {
            const parsed = new URL(body.url);
            sanitizedUrl = `${parsed.origin}${parsed.pathname}`.slice(0, MAX_URL_LENGTH);
          } catch {
            // If URL parsing fails, just truncate and store without query params
            sanitizedUrl = body.url.split('?')[0].split('#')[0].slice(0, MAX_URL_LENGTH);
          }
        }

        if (!host) {
          return jsonErrorResponse('Invalid host', 400);
        }

        const clientId = normalizeClientId(request.headers.get('X-RetractCheck-Client'));
        const rateConfig = getRateLimitConfig(env, clientId);
        const ip = getRequestIp(request);
        const quota = await enforceQuota(env.RETRACTCHECK_CACHE, rateConfig.override, 'override', clientId, ip);
        if (!quota.ok) {
          return quotaExceededResponse('override', quota);
        }

        // Note: User-Agent intentionally omitted to avoid storing PII
        const event = {
          host,
          url: sanitizedUrl,
          doi,
          triggeredAt: new Date().toISOString(),
          clientId,
        } satisfies OverrideEvent;

        await storeOverrideEvent(env.RETRACTCHECK_CACHE, event);

        // Send Telegram notification (fire-and-forget)
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          ctx.waitUntil(
            fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: env.TELEGRAM_CHAT_ID,
                text: `🔔 Host Request\n\nHost: ${host}\nURL: ${sanitizedUrl || 'N/A'}\nDOI: ${doi || 'N/A'}`,
              }),
            }).catch(() => {/* ignore notification failures */})
          );
        }

        return jsonResponse({ ok: true }, { status: 201, headers: rateLimitHeaders(quota) });
      } catch (error) {
        console.error('[override] failed', error);
        return jsonErrorResponse('Unable to record override', 500);
      }
    }

    if (request.method === "OPTIONS") return handleOptions();
    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      return methodNotAllowedResponse(['GET', 'HEAD', 'OPTIONS']);
    }

    if (url.pathname === "/v1/health") {
      const activeTable = await getActiveTableName(env.RETRACTCHECK_CACHE);
      return jsonResponse({
        ok: true,
        activeTable: activeTable || LEGACY_TABLE_NAME,
        usingLegacy: !activeTable,
      }, { isHead });
    }

    if (url.pathname === "/v1/info") {
      const metadataRaw = await env.RETRACTCHECK_CACHE.get(METADATA_KEY);
      let metadata: IngestMetadata | null = null;
      if (metadataRaw) {
        try {
          metadata = JSON.parse(metadataRaw) as IngestMetadata;
        } catch {
          console.warn('[info] Failed to parse metadata from cache');
        }
      }

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
      return jsonResponse(responseBody, {
        status: stale ? 503 : 200,
        headers: { 'Cache-Control': 'public, max-age=300' },
        isHead,
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
        return buildResponse({ doi: raw ?? '', meta: {}, records: [] }, isHead);
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
        return buildResponse(status, isHead, rateLimitHeaders(quota));
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

type QuotaResult =
  | { ok: true; limit: number; remaining: number; resetSeconds: number }
  | { ok: false; limit: number; remaining: 0; resetSeconds: number; scope: RateLimitScope };

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
  const resetSeconds = Math.max(1, (bucketStart + windowSeconds) - nowSeconds);

  const clientKey = `${QUOTA_PREFIX}:${type}:client:${clientId}:${bucketStart}`;
  const clientResult = await incrementCounter(cache, clientKey, config.limit, windowSeconds);
  if (!clientResult.allowed) {
    return { ok: false, limit: config.limit, remaining: 0, resetSeconds, scope: 'client' };
  }

  if (config.ipLimit) {
    const ipKey = `${QUOTA_PREFIX}:${type}:ip:${ip}:${bucketStart}`;
    const ipResult = await incrementCounter(cache, ipKey, config.ipLimit, windowSeconds);
    if (!ipResult.allowed) {
      return { ok: false, limit: config.ipLimit, remaining: 0, resetSeconds, scope: 'ip' };
    }
  }

  const remaining = Math.max(0, config.limit - clientResult.currentCount);
  return { ok: true, limit: config.limit, remaining, resetSeconds };
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
): Promise<{ allowed: boolean; currentCount: number }> {
  const raw = await cache.get(key);
  const current = raw ? Number(raw) : 0;

  if (Number.isFinite(current) && current >= limit) {
    return { allowed: false, currentCount: current };
  }

  const next = Number.isFinite(current) ? current + 1 : 1;
  await cache.put(key, String(next), { expirationTtl: windowSeconds });
  return { allowed: true, currentCount: next };
}

const RATE_LIMIT_RESPONSE_MESSAGES: Record<RateLimitType, string> = {
  status: 'Rate limit reached. Please wait before trying again.',
  override: 'Override rate limit reached. Please wait before trying again.',
};

function quotaExceededResponse(type: RateLimitType, result: Extract<QuotaResult, { ok: false }>): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: RATE_LIMIT_RESPONSE_MESSAGES[type],
      type,
      scope: result.scope,
      retryAfter: result.resetSeconds,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        ...STANDARD_HEADERS,
        'Retry-After': String(result.resetSeconds),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(result.resetSeconds),
      },
    },
  );
}

/**
 * Generate rate limit headers for successful responses
 */
function rateLimitHeaders(quota: Extract<QuotaResult, { ok: true }>): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(quota.limit),
    'X-RateLimit-Remaining': String(quota.remaining),
    'X-RateLimit-Reset': String(quota.resetSeconds),
  };
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
  clientId?: string;
};

async function storeOverrideEvent(cache: KVNamespace, event: OverrideEvent): Promise<void> {
  const key = `${OVERRIDE_KEY_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
  await cache.put(key, JSON.stringify(event), { expirationTtl: OVERRIDE_TTL_SECONDS });
}
