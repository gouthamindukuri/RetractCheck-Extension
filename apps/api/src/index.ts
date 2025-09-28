import type {
  ExecutionContext,
  ExportedHandler,
  KVNamespace,
  ScheduledController,
} from '@cloudflare/workers-types';
import { normaliseDoi } from '@retractcheck/doi';
import type { RetractionStatusResponse } from '@retractcheck/types';

import type { Env } from './env';
import { runIngest } from './ingest';

type RetractionRow = {
  record_id: number;
  raw: string;
  updated_at: number;
};

type IngestMetadata = {
  checksum: string;
  updatedAt: string;
};

const CACHE_TTL = 12 * 60 * 60; // 12h seconds
const METADATA_KEY = 'ingest:metadata';
const QUOTA_PREFIX = 'quota';
const RATE_LIMIT_ALLOW_HEADERS = 'Content-Type, X-RetractCheck-Client';

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

const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  status: {
    limit: 100,
    windowSeconds: 86_400,
    ipLimit: 200,
  },
  override: {
    limit: 10,
    windowSeconds: 172_800,
    ipLimit: 20,
  },
};
const OVERRIDE_KEY_PREFIX = 'override:';
const OVERRIDE_TTL_SECONDS = 60 * 60 * 24 * 90;

function buildResponse(body: RetractionStatusResponse): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': RATE_LIMIT_ALLOW_HEADERS,
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

  const stmt = env.RETRACTCHECK_DB.prepare(
    'SELECT record_id, raw, updated_at FROM entries WHERE doi_norm_original = ? OR doi_norm_retraction = ?'
  );
  const rows = await stmt.bind(doi, doi).all<RetractionRow>();

  const metadataRaw = await env.RETRACTCHECK_CACHE.get(METADATA_KEY);
  const metadata = metadataRaw ? (JSON.parse(metadataRaw) as IngestMetadata) : null;

  const response: RetractionStatusResponse = {
    doi,
    meta: {
      datasetVersion: metadata?.checksum,
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
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
      "Access-Control-Allow-Headers": RATE_LIMIT_ALLOW_HEADERS,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/v1/ingest") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      if (!env.INGEST_TOKEN) {
        return new Response("Ingest disabled", { status: 403 });
      }

      const authHeader = request.headers.get("authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      if (!token || token !== env.INGEST_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
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
        return new Response("Method Not Allowed", { status: 405 });
      }

      try {
        const body = (await request.json()) as Record<string, unknown>;
        const host = typeof body.host === 'string' ? body.host.toLowerCase() : null;
        const doi = typeof body.doi === 'string' ? body.doi.trim().toLowerCase() : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : undefined;
        if (!host) {
          return new Response(JSON.stringify({ ok: false, error: 'Invalid host' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': RATE_LIMIT_ALLOW_HEADERS,
            },
          });
        }

        const rateConfig = getRateLimitConfig(env);
        const clientId = normalizeClientId(request.headers.get('X-RetractCheck-Client'));
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
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': RATE_LIMIT_ALLOW_HEADERS,
          },
        });
      } catch (error) {
        console.error('[override] failed', error);
        return new Response(JSON.stringify({ ok: false, error: 'Unable to record override' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': RATE_LIMIT_ALLOW_HEADERS,
          },
        });
      }
    }

    if (request.method === "OPTIONS") return handleOptions();
    if (request.method !== "GET")
      return new Response("Method Not Allowed", { status: 405 });

    if (url.pathname === "/v1/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/v1/status") {
      const raw = url.searchParams.get("doi");
      const doi = normaliseDoi(raw);
      if (!raw || !doi) {
        return buildResponse({ doi: raw ?? '', meta: {}, records: [] });
      }

      const rateConfig = getRateLimitConfig(env);
      const clientId = normalizeClientId(request.headers.get('X-RetractCheck-Client'));
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
        return new Response("Internal Error", {
          status: 500,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': RATE_LIMIT_ALLOW_HEADERS,
          },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(handleCron(controller, env));
  },
} satisfies ExportedHandler<Env>;

function getRateLimitConfig(env: Env): RateLimitConfig {
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
  return DEFAULT_RATE_LIMITS;
}

function normalizeClientId(value: string | null): string {
  if (!value) return 'anon';
  const trimmed = value.trim();
  return trimmed || 'anon';
}

function getRequestIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('True-Client-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  );
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
  status: 'Daily lookup limit reached. Try again tomorrow.',
  override: 'Override limit reached. Try again in two days.',
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
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': RATE_LIMIT_ALLOW_HEADERS,
        'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
        'Retry-After': String(retryAfter),
      },
    },
  );
}

async function handleCron(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  return runIngest(env)
    .then((stats) => console.log('[ingest] complete', stats))
    .catch((err) => {
      console.error('[ingest] failed', err);
      throw err;
    });
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
