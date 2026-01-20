import './popup.css';
import type { RetractionStatusResponse } from '@retractcheck/types';

import { SITE_REQUEST_URL } from './constants';

type Settings = {
  remoteEnabled: boolean;
};

type RateLimitInfo = {
  type: 'status' | 'override';
  retryAt: number;
};

type MessageResponse = {
  ok: boolean;
  data?: RetractionStatusResponse;
  error?: string;
  rateLimit?: RateLimitInfo;
};

type PopupState = {
  doi: string | null;
  tabId?: number;
  supported: boolean;
  host?: string;
  url?: string;
};

const toggleEl = document.getElementById('toggle') as HTMLInputElement;
const doiTextEl = document.getElementById('doi-text') as HTMLElement;
const messageEl = document.getElementById('message') as HTMLElement;
const statusChipEl = document.getElementById('status-chip') as HTMLElement;
const recordsEl = document.getElementById('records') as HTMLElement;
const loadingEl = document.getElementById('loading') as HTMLElement;
const footerEl = document.getElementById('footer') as HTMLElement;
const footerTextEl = document.getElementById('footer-text') as HTMLElement;

let state: PopupState = { doi: null, supported: true };

document.addEventListener('DOMContentLoaded', initialise);

async function initialise(): Promise<void> {
  toggleEl.disabled = false;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = activeTab?.id;
  const context = await getActiveTabContext(tabId, activeTab);
  state = { ...context, tabId };

  const { doi, supported } = context;

  const settingsResponse = (await chrome.runtime.sendMessage({ type: 'retractcheck:get-settings' })) as {
    settings: Settings;
  };
  toggleEl.checked = settingsResponse.settings.remoteEnabled;

  toggleEl.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      type: 'retractcheck:set-settings',
      settings: { remoteEnabled: toggleEl.checked },
      tabId: state.tabId,
    });

    if (toggleEl.checked) {
      await queryAndRender();
    } else {
      renderDisabled();
    }
  });

  renderDoi(doi);

  if (!supported) {
    renderUnsupported();
    return;
  }

  if (!doi) {
    renderNoDoi();
    return;
  }

  if (!tabId) {
    renderError('Cannot determine the active tab. Please try reloading the page.');
    return;
  }

  if (!toggleEl.checked) {
    renderDisabled();
    return;
  }

  await queryAndRender();
}

async function queryAndRender(): Promise<void> {
  if (!state.doi || !state.supported) return;
  showLoading();

  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'retractcheck:query-doi',
      doi: state.doi,
      tabId: state.tabId,
      host: state.host,
    })) as MessageResponse;
    if (!response || !response.ok || !response.data) {
      if (response?.rateLimit) {
        renderRateLimit(response.rateLimit);
        return;
      }
      throw new Error(response?.error || 'Unable to fetch status. Please check your settings.');
    }

    renderRecords(response.data);
  } catch (err) {
    renderError(err instanceof Error ? err.message : String(err));
  }
}

function renderDoi(doi: string | null): void {
  doiTextEl.className = 'doi-value';

  if (!doi) {
    doiTextEl.textContent = 'Not detected';
    doiTextEl.classList.add('doi-value--muted');
    return;
  }

  const wrapper = document.createElement('span');
  wrapper.className = 'doi-value';

  const value = document.createElement('span');
  value.className = 'doi-value-text';
  value.textContent = doi;

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'doi-copy';
  copyButton.setAttribute('aria-label', 'Copy DOI');
  copyButton.textContent = 'Copy';

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(doi);
      copyButton.textContent = 'Copied!';
      setTimeout(() => {
        copyButton.textContent = 'Copy';
      }, 1500);
    } catch (error) {
      console.warn('[RetractCheck] copy failed', error);
      copyButton.textContent = 'Press ⌘/Ctrl+C';
      setTimeout(() => {
        copyButton.textContent = 'Copy';
      }, 2000);
    }
  });

  wrapper.append(value, copyButton);

  doiTextEl.innerHTML = '';
  doiTextEl.appendChild(wrapper);
}

function renderRecords(response: RetractionStatusResponse): void {
  hideLoading();
  clearMessage();

  const { records, meta } = response;
  updateStatusChip(records.length);
  recordsEl.innerHTML = '';

  // Show last updated date in footer
  if (meta?.updatedAt) {
    const date = new Date(meta.updatedAt);
    const formatted = date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    footerTextEl.textContent = `Data updated ${formatted}`;
    footerEl.hidden = false;
  } else {
    footerEl.hidden = true;
  }

  if (!records.length) return;

  for (const record of records) {
    const card = document.createElement('div');
    card.className = 'record-card';

    const dl = document.createElement('dl');
    appendField(dl, 'Title', record.raw.Title);
    appendField(dl, 'Article Type', record.raw.ArticleType);
    appendField(dl, 'Retraction Nature', record.raw.RetractionNature);
    appendField(dl, 'Reason(s)', record.raw.Reason);
    appendField(dl, 'Retraction Date', record.raw.RetractionDate);
    appendField(dl, 'Retraction DOI', hyperlink(record.raw.RetractionDOI, 'https://doi.org/'));
    appendField(dl, 'Retraction PubMed ID', hyperlink(record.raw.RetractionPubMedID, 'https://pubmed.ncbi.nlm.nih.gov/'));
    appendField(dl, 'Original DOI', hyperlink(record.raw.OriginalPaperDOI, 'https://doi.org/'));
    appendField(dl, 'Original PubMed ID', hyperlink(record.raw.OriginalPaperPubMedID, 'https://pubmed.ncbi.nlm.nih.gov/'));
    appendField(dl, 'Notes', record.raw.Notes);

    card.appendChild(dl);
    recordsEl.appendChild(card);
  }
}

function appendField(dl: HTMLDListElement, label: string, value?: string | HTMLElement | null): void {
  if (!value) return;

  const dt = document.createElement('dt');
  dt.textContent = label;

  const dd = document.createElement('dd');
  if (value instanceof HTMLElement) {
    dd.appendChild(value);
  } else {
    dd.textContent = value;
  }

  dl.append(dt, dd);
}

function hyperlink(value?: string, prefix = ''): HTMLElement | null {
  if (!value || value.trim() === '' || /unavailable/i.test(value)) return null;

  const rawUrl = prefix ? `${prefix}${value.trim()}` : value.trim();

  // Validate URL has safe protocol (defense in depth)
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Invalid URL - don't create a link
    return null;
  }

  // Only allow http and https protocols
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn('[RetractCheck] Blocked unsafe URL protocol:', url.protocol);
    return null;
  }

  const a = document.createElement('a');
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = value;
  return a;
}

function showLoading(): void {
  loadingEl.hidden = false;
  clearMessage();
  statusChipEl.textContent = 'Checking…';
  statusChipEl.className = 'status-chip status-chip--muted';
  recordsEl.innerHTML = '';
}

function renderError(message: string): void {
  hideLoading();
  setMessage(message, 'error');
  statusChipEl.textContent = 'Error';
  statusChipEl.className = 'status-chip status-chip--error';
  recordsEl.innerHTML = '';
  footerEl.hidden = true;
}

function renderDisabled(): void {
  hideLoading();
  setMessage('RetractCheck is paused. Toggle it back on to resume checks.', 'muted');
  statusChipEl.textContent = 'Paused';
  statusChipEl.className = 'status-chip status-chip--muted';
  recordsEl.innerHTML = '';
  footerEl.hidden = true;
}

function renderNoDoi(): void {
  hideLoading();
  setMessage('No DOI detected on this page.', 'muted');
  statusChipEl.textContent = 'No DOI';
  statusChipEl.className = 'status-chip status-chip--muted';
  recordsEl.innerHTML = '';
  footerEl.hidden = true;
}

function renderUnsupported(): void {
  hideLoading();
  statusChipEl.textContent = 'Unsupported';
  statusChipEl.className = 'status-chip status-chip--muted';
  recordsEl.innerHTML = '';
  footerEl.hidden = true;
  toggleEl.disabled = true;
  messageEl.hidden = false;
  messageEl.className = 'message message--muted';
  messageEl.textContent = '';

  const note = document.createElement('p');
  note.textContent = 'This website is not on the supported list.';

  const actions = document.createElement('div');
  actions.className = 'unsupported-actions';

  const requestLink = document.createElement('a');
  requestLink.href = SITE_REQUEST_URL;
  requestLink.target = '_blank';
  requestLink.rel = 'noreferrer';
  requestLink.textContent = 'Open a support request';
  requestLink.className = 'link';

  const overrideButton = document.createElement('button');
  overrideButton.type = 'button';
  overrideButton.className = 'button button--primary';
  overrideButton.textContent = 'Check anyway';
  if (!state.host) {
    overrideButton.disabled = true;
  }
  overrideButton.addEventListener('click', () => {
    void handleOverride(overrideButton);
  });

  actions.append(overrideButton, requestLink);
  messageEl.append(note, actions);
}

function renderRateLimit(info: RateLimitInfo): void {
  hideLoading();
  const retryText = formatRetryTime(info.retryAt);
  const message =
    info.type === 'status'
      ? `Rate limit reached. Try again ${retryText}.`
      : `Override limit reached. Try again ${retryText}.`;
  setMessage(message, 'muted');
  statusChipEl.textContent = info.type === 'status' ? 'Limited' : 'Override limited';
  statusChipEl.className = 'status-chip status-chip--muted';
  recordsEl.innerHTML = '';
  footerEl.hidden = true;
}

function hideLoading(): void {
  loadingEl.hidden = true;
}

function setMessage(text: string, tone: 'muted' | 'error'): void {
  messageEl.hidden = false;
  messageEl.textContent = text;
  messageEl.className = `message message--${tone}`;
}

function clearMessage(): void {
  messageEl.hidden = true;
  messageEl.textContent = '';
}

function updateStatusChip(count: number): void {
  if (count > 0) {
    statusChipEl.textContent = `${count} notice${count > 1 ? 's' : ''}`;
    statusChipEl.className = 'status-chip status-chip--accent';
  } else {
    statusChipEl.textContent = 'No notices';
    statusChipEl.className = 'status-chip status-chip--muted';
  }
}

function formatRetryTime(timestamp: number): string {
  const diffMs = timestamp - Date.now();
  if (diffMs <= 0) return 'soon';
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 60) {
    const minutes = Math.max(1, diffMinutes);
    return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `in ${diffHours} hour${diffHours === 1 ? '' : 's'}`;
  }
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) {
    return `in ${diffDays} day${diffDays === 1 ? '' : 's'}`;
  }
  return `after ${new Date(timestamp).toLocaleString()}`;
}

async function getActiveTabContext(
  tabId?: number,
  tab?: chrome.tabs.Tab,
): Promise<{ doi: string | null; supported: boolean; host?: string; url?: string }> {
  if (!tabId) return { doi: null, supported: true };

  let host: string | undefined;
  let url: string | undefined;
  if (tab?.url) {
    try {
      const parsed = new URL(tab.url);
      host = parsed.hostname.toLowerCase();
      url = tab.url;
    } catch (err) {
      console.warn('[RetractCheck] tab URL parse failed', err);
    }
  }

  try {
    const response = await new Promise<{ doi: string | null; supported?: boolean; host?: string }>(
      (resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: 'retractcheck:get-doi' }, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve({
            doi: (result?.doi as string | null) ?? null,
            supported: result?.supported !== false,
            host: typeof result?.host === 'string' ? result.host : undefined,
          });
        });
      },
    );
    if (response) {
      host = response.host ?? host;
      return {
        doi: response.doi,
        supported: response.supported !== false,
        host,
        url,
      };
    }
  } catch (err) {
    console.warn('[RetractCheck] message fallback to scripting', err);
  }

  try {
    // Execute in MAIN world to access content script's window properties
    // Type assertion needed since these globals are set by content.ts
    type RetractCheckWindow = Window & {
      __RETRACTCHECK_DOI?: string | null;
      __RETRACTCHECK_SUPPORTED?: boolean;
      __RETRACTCHECK_HOST?: string | null;
    };
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const w = window as RetractCheckWindow;
        return {
          doi: w.__RETRACTCHECK_DOI ?? null,
          supported: w.__RETRACTCHECK_SUPPORTED !== false,
          host: w.__RETRACTCHECK_HOST ?? null,
        };
      },
      world: 'MAIN',
    });
    const fallback = results[0]?.result as { doi: string | null; supported?: boolean; host?: string } | undefined;
    return {
      doi: fallback?.doi ?? null,
      supported: fallback?.supported !== false,
      host: fallback?.host ?? host,
      url,
    };
  } catch (err) {
    console.error('[RetractCheck] executeScript error', err);
    return { doi: null, supported: true, host, url };
  }
}

async function handleOverride(button: HTMLButtonElement): Promise<void> {
  if (!state.tabId || !state.host) return;
  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = 'Enabling…';
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'retractcheck:add-override',
      host: state.host,
      url: state.url,
      doi: state.doi,
      tabId: state.tabId,
    })) as MessageResponse;
    if (!response || !response.ok) {
      if (response?.rateLimit) {
        renderRateLimit(response.rateLimit);
        button.textContent = 'Limit reached';
        return;
      }
      throw new Error(response?.error || 'Unable to enable override');
    }
    state.supported = true;
    toggleEl.disabled = false;
    messageEl.hidden = true;
    if (state.doi) {
      await queryAndRender();
    } else {
      renderNoDoi();
    }
  } catch (error) {
    console.error('[RetractCheck] override failed', error);
    button.disabled = false;
    button.textContent = previousLabel ?? 'Check anyway';
    renderError(error instanceof Error ? error.message : String(error));
    return;
  }
  button.disabled = false;
  button.textContent = previousLabel ?? 'Check anyway';
}
