import type { RetractionStatusResponse, ExtensionSettings } from '@retractcheck/types';

import { OVERRIDES_KEY } from './constants';

const globalScope = globalThis as typeof globalThis & {
  browser?: typeof chrome;
  chrome?: typeof chrome;
};

if (typeof globalScope.browser === 'undefined' && typeof globalScope.chrome !== 'undefined') {
  globalScope.browser = globalScope.chrome;
}

if (typeof globalScope.chrome === 'undefined' && typeof globalScope.browser !== 'undefined') {
  globalScope.chrome = globalScope.browser as typeof chrome;
}

declare const __WORKER_ENDPOINT__: string;

const STORAGE_KEY = 'retractcheck:settings';
const CACHE_KEY = 'retractcheck:cache';
const CLIENT_ID_KEY = 'retractcheck:client-id';
const RATE_LIMIT_KEY = 'retractcheck:rate-limit';
type RateLimitType = 'status' | 'override';
type RateLimitState = {
  statusUntil?: number;
  overrideUntil?: number;
};

const RATE_LIMIT_MESSAGES: Record<RateLimitType, string> = {
  status: 'Daily lookup limit reached. Try again tomorrow.',
  override: 'Override limit reached. Try again in two days.',
};

class RateLimitError extends Error {
  type: RateLimitType;
  retryAt: number;

  constructor(type: RateLimitType, retryAt: number, message?: string) {
    super(message ?? RATE_LIMIT_MESSAGES[type]);
    this.type = type;
    this.retryAt = retryAt;
  }
}
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const RATE_LIMIT_FALLBACK_STATUS = 86400; // 1 day in seconds
const RATE_LIMIT_FALLBACK_OVERRIDE = 172800; // 2 days in seconds
const BADGE_COLOR = '#DC2626';
const BADGE_MAX_COUNT = 99;
const BADGE_DISABLED_TITLE = 'RetractCheck (checks disabled)';
const DEFAULT_TITLE = 'RetractCheck';
const INTERNAL_STATE_KEY = 'retractcheck:internal';

type CacheEntry = {
  doi: string;
  meta?: RetractionStatusResponse['meta'];
  records: RetractionStatusResponse['records'];
  expiresAt: number;
};

type TabSnapshot = {
  doi?: string;
  count?: number;
  supported?: boolean;
  host?: string;
};

type InternalState = {
  tabs: Record<number, TabSnapshot | undefined>;
};

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'retractcheck:get-settings') {
    getSettings().then((settings) => sendResponse({ settings }));
    return true;
  }

  if (message?.type === 'retractcheck:set-settings') {
    saveSettings(message.settings)
      .then(async () => {
        const tabId = message.tabId ?? sender.tab?.id;
        if (!message.settings.remoteEnabled) {
          await clearBadge(tabId, BADGE_DISABLED_TITLE);
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message?.type === 'retractcheck:query-doi') {
    handleQuery(message.doi, message.tabId ?? sender.tab?.id, { host: message.host })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => {
        if (error instanceof RateLimitError) {
          sendResponse({
            ok: false,
            error: error.message,
            rateLimit: { type: error.type, retryAt: error.retryAt },
          });
        } else {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    return true;
  }

  if (message?.type === 'retractcheck:page-doi') {
    void processPageDoiMessage(message, sender.tab?.id);
    return false;
  }

  if (message?.type === 'retractcheck:add-override') {
    addOverride(message.host, {
      url: message.url,
      doi: message.doi,
      tabId: message.tabId ?? sender.tab?.id,
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        if (error instanceof RateLimitError) {
          sendResponse({
            ok: false,
            error: error.message,
            rateLimit: { type: error.type, retryAt: error.retryAt },
          });
        } else {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    return true;
  }

  return false;
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const snapshot = (await getInternalState()).tabs[tabId];
  if (snapshot?.supported === false) {
    await clearBadge(tabId);
    return;
  }

  if (!snapshot?.doi) {
    await clearBadge(tabId);
    return;
  }

  if (snapshot.count !== undefined) {
    await updateBadge(tabId, snapshot.count);
  }

  try {
    await handleQuery(snapshot.doi, tabId, { host: snapshot.host });
  } catch (error) {
    console.warn('[RetractCheck] badge refresh failed on activation', error);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await rememberTabState(tabId, undefined);
});

async function handleQuery(
  rawDoi: string | null,
  tabId?: number,
  opts: { supported?: boolean; host?: string } = {},
): Promise<RetractionStatusResponse> {
  const doi = (rawDoi ?? '').trim().toLowerCase();
  if (!doi) {
    await rememberTabState(tabId, undefined);
    await clearBadge(tabId);
    return { doi: rawDoi ?? '', meta: {}, records: [] };
  }

  const host = opts.host?.toLowerCase();
  const overrides = host ? await getOverrides() : null;
  const overrideActive = host ? Boolean(overrides?.[host]) : false;
  const effectiveSupported = overrideActive || opts.supported !== false;

  if (opts.supported === false && !overrideActive) {
    await rememberTabState(tabId, { doi, supported: false, host });
    await clearBadge(tabId);
    return { doi, meta: {}, records: [] };
  }

  const activeLimit = await getActiveLimit('status');
  if (activeLimit) {
    throw new RateLimitError('status', activeLimit);
  }

  const settings = await getSettings();
  if (!settings.remoteEnabled) {
    await rememberTabState(tabId, { doi, host, supported: effectiveSupported });
    await clearBadge(tabId, BADGE_DISABLED_TITLE);
    return { doi, meta: {}, records: [] };
  }

  const cache = await getCache();
  const cached = cache[doi];
  if (cached && !isExpired(cached)) {
    // Return cached response without incrementing rate limit
    // (rate limit should only count actual API calls)
    const response = {
      doi,
      meta: cached.meta ?? {},
      records: cached.records,
    } satisfies RetractionStatusResponse;
    const count = response.records.length;
    await rememberTabState(tabId, { doi, count, host, supported: effectiveSupported });
    await updateBadge(tabId, count);
    return response;
  }

  const clientId = await getClientId();

  try {
    const response = await fetchStatusFromWorker(doi, clientId);
    await updateRateLimit('status');
    cache[doi] = {
      doi,
      meta: response.meta,
      records: response.records,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    await saveCache(cache);
    const count = response.records.length;
    await rememberTabState(tabId, {
      doi,
      count,
      supported: effectiveSupported,
      host,
    });
    await updateBadge(tabId, count);
    return response;
  } catch (error) {
    if (error instanceof RateLimitError) {
      await updateRateLimit(error.type, error.retryAt);
      if (error.type === 'status' && tabId !== undefined) {
        await rememberTabState(tabId, { doi, host, supported: effectiveSupported });
        await clearBadge(tabId);
      }
    }
    throw error;
  }
}

async function fetchStatusFromWorker(doi: string, clientId: string): Promise<RetractionStatusResponse> {
  const url = new URL('/v1/status', WORKER_ENDPOINT);
  url.searchParams.set('doi', doi);

  const res = await fetch(url.toString(), {
    headers: {
      'Content-Type': 'application/json',
      'X-RetractCheck-Client': clientId,
    },
  });
  if (res.status === 429) {
    await handleRateLimitResponse('status', res);
  }
  if (!res.ok) {
    throw new Error(`Worker request failed (${res.status})`);
  }
  return (await res.json()) as RetractionStatusResponse;
}

function isExpired(entry: CacheEntry): boolean {
  return Date.now() > entry.expiresAt;
}

async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const settings = stored[STORAGE_KEY] as ExtensionSettings | undefined;
  return settings ?? { remoteEnabled: true };
}

function saveSettings(settings: ExtensionSettings): Promise<void> {
  return chrome.storage.sync.set({ [STORAGE_KEY]: settings });
}

async function getCache(): Promise<Record<string, CacheEntry>> {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return (stored[CACHE_KEY] as Record<string, CacheEntry> | undefined) ?? {};
}

/**
 * Save cache after pruning expired entries to prevent unbounded growth.
 * Chrome local storage has a 10MB limit; pruning keeps us well under.
 */
function saveCache(cache: Record<string, CacheEntry>): Promise<void> {
  const now = Date.now();
  const pruned: Record<string, CacheEntry> = {};
  for (const [doi, entry] of Object.entries(cache)) {
    if (entry.expiresAt > now) {
      pruned[doi] = entry;
    }
  }
  return chrome.storage.local.set({ [CACHE_KEY]: pruned });
}

const WORKER_ENDPOINT = __WORKER_ENDPOINT__;

async function updateBadge(tabId: number | undefined, count: number): Promise<void> {
  if (!tabId) return;
  try {
    if (count > 0) {
      const text = count > BADGE_MAX_COUNT ? '99+' : String(count);
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setTitle({ tabId, title: `${DEFAULT_TITLE}: ${text} notice(s)` });
    } else {
      await clearBadge(tabId);
    }
  } catch (error) {
    console.warn('[RetractCheck] badge update failed', error);
  }
}

async function clearBadge(tabId: number | undefined, title: string = DEFAULT_TITLE): Promise<void> {
  if (!tabId) return;
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title });
  } catch (error) {
    console.warn('[RetractCheck] badge clear failed', error);
  }
}

async function rememberTabState(tabId: number | undefined, snapshot: TabSnapshot | undefined): Promise<void> {
  if (tabId === undefined) return;
  const state = await getInternalState();
  if (snapshot) {
    state.tabs[tabId] = snapshot;
  } else {
    delete state.tabs[tabId];
  }
  await setInternalState(state);
}

async function getInternalState(): Promise<InternalState> {
  const stored = await chrome.storage.session.get(INTERNAL_STATE_KEY);
  const state = stored[INTERNAL_STATE_KEY] as InternalState | undefined;
  return state ?? { tabs: {} };
}

function setInternalState(state: InternalState): Promise<void> {
  return chrome.storage.session.set({ [INTERNAL_STATE_KEY]: state });
}

async function getClientId(): Promise<string> {
  const stored = await chrome.storage.local.get(CLIENT_ID_KEY);
  let id = stored[CLIENT_ID_KEY] as string | undefined;
  if (typeof id !== 'string' || !id) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: id });
  }
  return id;
}

async function getRateLimitState(): Promise<RateLimitState> {
  const stored = await chrome.storage.local.get(RATE_LIMIT_KEY);
  return (stored[RATE_LIMIT_KEY] as RateLimitState | undefined) ?? {};
}

async function updateRateLimit(type: RateLimitType, retryAt?: number): Promise<void> {
  const state = await getRateLimitState();
  const key = type === 'status' ? 'statusUntil' : 'overrideUntil';
  if (typeof retryAt === 'number' && retryAt > Date.now()) {
    state[key] = retryAt;
  } else {
    delete state[key];
  }
  await chrome.storage.local.set({ [RATE_LIMIT_KEY]: state });
}

async function getActiveLimit(type: RateLimitType): Promise<number | null> {
  const state = await getRateLimitState();
  const key = type === 'status' ? 'statusUntil' : 'overrideUntil';
  const until = state[key];
  if (typeof until === 'number') {
    if (until > Date.now()) {
      return until;
    }
    delete state[key];
    await chrome.storage.local.set({ [RATE_LIMIT_KEY]: state });
  }
  return null;
}

async function handleRateLimitResponse(type: RateLimitType, res: Response): Promise<never> {
  let retryAfterSeconds: number | undefined;
  let message: string | undefined;
  try {
    const data = (await res.clone().json()) as {
      error?: string;
      retryAfter?: number;
    };
    if (typeof data?.retryAfter === 'number' && Number.isFinite(data.retryAfter)) {
      retryAfterSeconds = data.retryAfter;
    }
    if (typeof data?.error === 'string') {
      message = data.error;
    }
  } catch {
    // ignore JSON parsing errors
  }

  const header = res.headers.get('Retry-After');
  if (retryAfterSeconds === undefined && header) {
    const numeric = Number(header);
    if (!Number.isNaN(numeric)) {
      retryAfterSeconds = numeric;
    } else {
      const parsed = Date.parse(header);
      if (!Number.isNaN(parsed)) {
        retryAfterSeconds = Math.max(0, Math.round((parsed - Date.now()) / 1000));
      }
    }
  }

  const fallbackSeconds = type === 'override' ? RATE_LIMIT_FALLBACK_OVERRIDE : RATE_LIMIT_FALLBACK_STATUS;
  const retryAt = Date.now() + (retryAfterSeconds ?? fallbackSeconds) * 1000;
  throw new RateLimitError(type, retryAt, message);
}

async function addOverride(
  host: unknown,
  details: { url?: unknown; doi?: unknown; tabId?: number | undefined },
): Promise<void> {
  if (typeof host !== 'string' || !host) {
    throw new Error('Invalid host');
  }
  const normalizedHost = host.toLowerCase();
  const clientId = await getClientId();

  const activeLimit = await getActiveLimit('override');
  if (activeLimit) {
    throw new RateLimitError('override', activeLimit);
  }

  try {
    await sendOverrideEvent(
      {
        host: normalizedHost,
        url: typeof details.url === 'string' ? details.url : undefined,
        doi: typeof details.doi === 'string' ? details.doi : undefined,
      },
      clientId,
    );
    await updateRateLimit('override');
  } catch (error) {
    if (error instanceof RateLimitError) {
      await updateRateLimit(error.type, error.retryAt);
    }
    throw error;
  }

  const overrides = await getOverrides();
  overrides[normalizedHost] = true;
  await saveOverrides(overrides);

  if (details.tabId !== undefined) {
    try {
      await new Promise<void>((resolve, reject) => {
        chrome.tabs.sendMessage(details.tabId!, { type: 'retractcheck:force-run' }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    } catch (error) {
      console.warn('[RetractCheck] force-run message failed', error);
    }
  }
}

async function getOverrides(): Promise<Record<string, boolean>> {
  const stored = await chrome.storage.sync.get(OVERRIDES_KEY);
  return (stored?.[OVERRIDES_KEY] as Record<string, boolean> | undefined) ?? {};
}

function saveOverrides(overrides: Record<string, boolean>): Promise<void> {
  return chrome.storage.sync.set({ [OVERRIDES_KEY]: overrides });
}

async function sendOverrideEvent(
  event: { host: string; url?: string; doi?: string },
  clientId: string,
): Promise<void> {
  const url = new URL('/v1/override', WORKER_ENDPOINT);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RetractCheck-Client': clientId,
      },
      body: JSON.stringify({
        ...event,
        version: chrome.runtime.getManifest().version,
      }),
    });
    if (res.status === 429) {
      await handleRateLimitResponse('override', res);
    }
    if (!res.ok) {
      throw new Error(`Worker request failed (${res.status})`);
    }
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    console.warn('[RetractCheck] override log failed', error);
    throw error;
  }
}

async function processPageDoiMessage(
  message: { doi?: unknown; supported?: unknown; host?: unknown },
  tabId?: number,
): Promise<void> {
  const host = typeof message.host === 'string' ? message.host.toLowerCase() : undefined;
  const overrides = host ? await getOverrides() : {};
  const hasOverride = host ? Boolean(overrides[host]) : false;
  const supported = message.supported !== false || hasOverride;
  const doi = typeof message.doi === 'string' ? message.doi : '';

  if (!supported) {
    await rememberTabState(tabId, { doi: doi || undefined, supported: false, host });
    await clearBadge(tabId);
    return;
  }

  try {
    await handleQuery(doi, tabId, { supported: true, host });
  } catch (error) {
    if (error instanceof RateLimitError) {
      if (error.type === 'status') {
        await clearBadge(tabId);
      }
      // Rate limit errors are expected, no need to log
      return;
    }

    // Log actual errors with context for debugging
    console.error('[RetractCheck] page-doi query failed', {
      doi: doi || '(empty)',
      host: host || '(unknown)',
      tabId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await clearBadge(tabId);
  }
}
