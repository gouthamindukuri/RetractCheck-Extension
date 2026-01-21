import { describe, expect, it } from 'vitest';

import handler from '../src/index';
import type { Env } from '../src/env';

type MockRow = { record_id: number; raw: string; updated_at: number };

const mockRow: MockRow = {
  record_id: 1,
  raw: JSON.stringify({ Title: 'Sample Retraction' }),
  updated_at: 123,
};

type EnvOverrides = Partial<Env & { dbRows: MockRow[] }>;

function makeEnv(overrides: EnvOverrides = {}): Env {
  const cacheStore = new Map<string, string>();
  const dbRows = overrides.dbRows ?? [mockRow];

  return {
    RETRACTCHECK_CACHE: {
      async get(key: string) {
        if (key === 'ingest:metadata') {
          return JSON.stringify({
            tableName: 'entries_20250101000000',
            rowCount: 1000,
            updatedAt: '2025-01-01T00:00:00.000Z'
          });
        }
        if (key === 'ingest:active_table') {
          return 'entries_20250101000000';
        }
        return cacheStore.get(key) ?? null;
      },
      async put(key: string, value: string, _options?: Record<string, unknown>) {
        cacheStore.set(key, value);
      },
    },
    RETRACTCHECK_DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: dbRows }),
        }),
      }),
    },
    API_VERSION: 'v1',
    ...overrides,
  } as unknown as Env;
}

describe('status handler', () => {
  it('returns records and metadata', async () => {
    const request = new Request('https://example.com/v1/status?doi=10.1000/xyz');
    const response = await handler.fetch(request, makeEnv());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.records).toHaveLength(1);
    expect(json.meta.datasetVersion).toBe('entries_20250101000000');
    expect(json.meta.updatedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('returns empty payload for missing DOI', async () => {
    const res = await handler.fetch(new Request('https://example.com/v1/status?doi='), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toHaveLength(0);
  });
});

describe('rate limits', () => {
  const rateConfig = JSON.stringify({
    status: { limit: 2, windowSeconds: 60, ipLimit: 3 },
    override: { limit: 1, windowSeconds: 60, ipLimit: 2 },
  });

  it('enforces status quota per client', async () => {
    const env = makeEnv({ RATE_LIMIT_CONFIG: rateConfig });
    const buildRequest = () =>
      new Request('https://example.com/v1/status?doi=10.1000/xyz', {
        headers: {
          'X-RetractCheck-Client': 'client-a',
          'CF-Connecting-IP': '203.0.113.1',
        },
      });

    const ok1 = await handler.fetch(buildRequest(), env);
    expect(ok1.status).toBe(200);
    const ok2 = await handler.fetch(buildRequest(), env);
    expect(ok2.status).toBe(200);
    const limited = await handler.fetch(buildRequest(), env);
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.type).toBe('status');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('enforces override quota per client', async () => {
    const env = makeEnv({ RATE_LIMIT_CONFIG: rateConfig });
    const buildRequest = (clientId: string) =>
      new Request('https://example.com/v1/override', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RetractCheck-Client': clientId,
          'CF-Connecting-IP': '203.0.113.5',
        },
        body: JSON.stringify({ host: 'example.com' }),
      });

    const ok = await handler.fetch(buildRequest('client-a'), env);
    expect(ok.status).toBe(201); // POST creates resource, returns 201
    const limitedClient = await handler.fetch(buildRequest('client-a'), env);
    expect(limitedClient.status).toBe(429);
    const bodyClient = await limitedClient.json();
    expect(bodyClient.type).toBe('override');
  });

  it('enforces override quota per ip', async () => {
    const env = makeEnv({
      RATE_LIMIT_CONFIG: JSON.stringify({
        status: { limit: 5, windowSeconds: 60, ipLimit: 5 },
        override: { limit: 5, windowSeconds: 60, ipLimit: 2 },
      }),
    });

    const buildRequest = (clientId: string) =>
      new Request('https://example.com/v1/override', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RetractCheck-Client': clientId,
          'CF-Connecting-IP': '203.0.113.10',
        },
        body: JSON.stringify({ host: 'example.com' }),
      });

    const first = await handler.fetch(buildRequest('client-a'), env);
    expect(first.status).toBe(201); // POST creates resource, returns 201
    const second = await handler.fetch(buildRequest('client-b'), env);
    expect(second.status).toBe(201); // POST creates resource, returns 201
    const limited = await handler.fetch(buildRequest('client-c'), env);
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.type).toBe('override');
    expect(body.retryAfter).toBeGreaterThan(0);
  });
});
