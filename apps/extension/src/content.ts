import { extractPrimaryDoi } from '@retractcheck/doi';

import { OVERRIDES_KEY } from './constants';
import { shouldActivate, hookSpaNavigation, isSupportedLocation } from './gate';

declare global {
  interface Window {
    __RETRACTCHECK_DOI?: string | null;
    __RETRACTCHECK_SUPPORTED?: boolean;
    __RETRACTCHECK_HOST?: string | null;
  }
}

let lastUrl = '';
let runDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function run(force = false) {
  const host = location.hostname?.toLowerCase() ?? '';
  window.__RETRACTCHECK_HOST = host || null;

  let supported = isSupportedLocation();
  if (!supported && host) {
    supported = await hasOverride(host);
  }
  window.__RETRACTCHECK_SUPPORTED = supported;

  const doi = extractPrimaryDoi() || null;
  window.__RETRACTCHECK_DOI = doi;

  if (!force && location.href === lastUrl) return;
  lastUrl = location.href;

  try {
    await chrome.runtime.sendMessage({ type: 'retractcheck:page-doi', doi, supported, host });
  } catch (error) {
    console.warn('[RetractCheck] unable to inform background about DOI', error);
  }

  if (!supported) return;
  if (!shouldActivate(document)) return;
}

document.addEventListener('DOMContentLoaded', () => {
  void run(true);
});
run(true);

// Hook SPA navigation and store cleanup function
const cleanupSpaHook = hookSpaNavigation(() => {
  if (runDebounceTimer) clearTimeout(runDebounceTimer);
  runDebounceTimer = setTimeout(() => {
    runDebounceTimer = null;
    void run(true);
  }, 200);
});

window.addEventListener('pageshow', () => {
  lastUrl = '';
  if (runDebounceTimer) clearTimeout(runDebounceTimer);
  runDebounceTimer = setTimeout(() => {
    runDebounceTimer = null;
    void run(true);
  }, 0);
});

// Cleanup on page unload (good practice, though content scripts are destroyed anyway)
window.addEventListener('pagehide', () => {
  cleanupSpaHook();
  if (runDebounceTimer) {
    clearTimeout(runDebounceTimer);
    runDebounceTimer = null;
  }
});

chrome.runtime?.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'retractcheck:get-doi') {
    sendResponse({
      doi: window.__RETRACTCHECK_DOI ?? null,
      supported: window.__RETRACTCHECK_SUPPORTED !== false,
      host: window.__RETRACTCHECK_HOST ?? null,
    });
  }

  if (message?.type === 'retractcheck:force-run') {
    void run(true);
  }
});

async function hasOverride(host: string): Promise<boolean> {
  if (!chrome?.storage?.sync) return false;
  try {
    const stored = await chrome.storage.sync.get(OVERRIDES_KEY);
    const overrides = (stored?.[OVERRIDES_KEY] as Record<string, boolean> | undefined) ?? {};
    return Boolean(overrides[host]);
  } catch (error) {
    console.warn('[RetractCheck] override lookup failed', error);
    return false;
  }
}
