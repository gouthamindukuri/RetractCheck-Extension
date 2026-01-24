import './popup.css';
import type { RetractionStatusResponse, RetractionRecord, ExtensionSettings, RateLimitInfo } from '@retractcheck/types';

import { SITE_REQUEST_URL } from './constants';

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

// SVG Icons
const ICONS = {
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>`,
  alertTriangle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`,
  shieldCheck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <path d="M9 12l2 2 4-4"/>
  </svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="16" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="6" y="4" width="4" height="16"/>
    <rect x="14" y="4" width="4" height="16"/>
  </svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </svg>`,
  externalLink: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/>
    <line x1="10" y1="14" x2="21" y2="3"/>
  </svg>`,
};

// Safely set SVG content using DOMParser
function setSvgContent(element: HTMLElement, svgString: string): void {
  element.replaceChildren();
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString.trim(), 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg && svg.nodeName === 'svg') {
    element.appendChild(element.ownerDocument.importNode(svg, true));
  }
}

// Clear all children from an element
function clearChildren(element: HTMLElement): void {
  element.replaceChildren();
}

// DOM Elements
const toggleEl = document.getElementById('toggle') as HTMLInputElement;
const doiValueEl = document.getElementById('doi-value') as HTMLElement;
const doiTextEl = document.getElementById('doi-text') as HTMLElement;
const statusHeroEl = document.getElementById('status-hero') as HTMLElement;
const statusIconEl = document.getElementById('status-icon') as HTMLElement;
const statusLabelEl = document.getElementById('status-label') as HTMLElement;
const statusMetaEl = document.getElementById('status-meta') as HTMLElement;
const alertBannerEl = document.getElementById('alert-banner') as HTMLElement;
const alertIconEl = document.getElementById('alert-icon') as HTMLElement;
const alertTextEl = document.getElementById('alert-text') as HTMLElement;
const alertMetaEl = document.getElementById('alert-meta') as HTMLElement;
const noticesEl = document.getElementById('notices') as HTMLElement;
const messageEl = document.getElementById('message') as HTMLElement;
const loadingEl = document.getElementById('loading') as HTMLElement;

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
    settings: ExtensionSettings;
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
  doiTextEl.className = 'doi-text';

  if (!doi) {
    doiTextEl.textContent = 'Not detected';
    doiTextEl.classList.add('doi-text--muted');
    doiTextEl.removeAttribute('title');
    const existingBtn = doiValueEl.querySelector('.doi-copy-btn');
    if (existingBtn) existingBtn.remove();
    return;
  }

  // Truncate long DOIs
  const truncated = doi.length > 30 ? doi.slice(0, 30) + '...' : doi;
  doiTextEl.textContent = truncated;
  if (doi.length > 30) {
    doiTextEl.title = doi;
  }

  // Create copy button
  let copyButton = doiValueEl.querySelector('.doi-copy-btn') as HTMLButtonElement | null;
  if (!copyButton) {
    copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'doi-copy-btn';
    copyButton.setAttribute('aria-label', 'Copy DOI');
    setSvgContent(copyButton, ICONS.copy);
    doiValueEl.appendChild(copyButton);

    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(doi);
        setSvgContent(copyButton!, ICONS.check);
        copyButton!.classList.add('doi-copy-btn--success');
        setTimeout(() => {
          setSvgContent(copyButton!, ICONS.copy);
          copyButton!.classList.remove('doi-copy-btn--success');
        }, 1500);
      } catch (error) {
        console.warn('[RetractCheck] copy failed', error);
      }
    });
  }
}

function showStatusHero(variant: 'clear' | 'muted' | 'warning', icon: string, label: string, meta?: string): void {
  statusHeroEl.className = `status-hero status-hero--${variant}`;
  setSvgContent(statusIconEl, icon);
  statusLabelEl.textContent = label;
  statusMetaEl.textContent = meta || '';
  statusHeroEl.hidden = false;
  alertBannerEl.hidden = true;
  noticesEl.hidden = true;
}

function showAlertBanner(count: number, meta?: string): void {
  setSvgContent(alertIconEl, ICONS.alertTriangle);
  alertTextEl.textContent = count === 1 ? '1 Notice Found' : `${count} Notices Found`;
  alertMetaEl.textContent = meta ? `As of ${meta}` : '';
  alertBannerEl.hidden = false;
  statusHeroEl.hidden = true;
}

function formatDataFreshness(updatedAt?: string): string {
  if (!updatedAt) return '';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function renderRecords(response: RetractionStatusResponse): void {
  hideLoading();
  clearMessage();

  const { records, meta } = response;
  const freshness = formatDataFreshness(meta?.updatedAt);

  clearChildren(noticesEl);

  if (records.length === 0) {
    showStatusHero('clear', ICONS.shieldCheck, 'No Notices Found', freshness ? `Data as of ${freshness}` : '');
    noticesEl.hidden = true;
    return;
  }

  // Show alert banner for notices
  showAlertBanner(records.length, freshness);

  // Render notice cards
  noticesEl.hidden = false;
  for (const record of records) {
    noticesEl.appendChild(createNoticeCard(record));
  }
}

function createNoticeCard(record: RetractionRecord): HTMLElement {
  const card = document.createElement('div');
  card.className = 'notice-card';

  // Determine type based on RetractionNature
  const nature = (record.raw.RetractionNature || '').toLowerCase();
  if (nature.includes('retraction')) {
    card.classList.add('notice-card--retraction');
  } else if (nature.includes('correction')) {
    card.classList.add('notice-card--correction');
  } else if (nature.includes('concern') || nature.includes('expression')) {
    card.classList.add('notice-card--concern');
  } else {
    card.classList.add('notice-card--retraction');
  }

  // Header with type and reason
  const header = document.createElement('div');
  header.className = 'notice-card-header';

  const typeEl = document.createElement('div');
  typeEl.className = 'notice-card-type';
  typeEl.textContent = record.raw.RetractionNature || 'Notice';

  const reasonEl = document.createElement('div');
  reasonEl.className = 'notice-card-reason';
  reasonEl.textContent = record.raw.Reason || 'No reason provided';

  header.appendChild(typeEl);
  header.appendChild(reasonEl);
  card.appendChild(header);

  // Body with details
  const body = document.createElement('div');
  body.className = 'notice-card-body';

  addField(body, 'Title', record.raw.Title);
  addField(body, 'Article Type', record.raw.ArticleType);
  addField(body, 'Date', record.raw.RetractionDate);
  if (record.raw.Notes) {
    addField(body, 'Notes', record.raw.Notes);
  }

  card.appendChild(body);

  // Links section - two rows
  const links = document.createElement('div');
  links.className = 'notice-card-links';

  // Row 1: Retraction links
  const retractionLink = createLinkElement(record.raw.RetractionDOI, 'https://doi.org/', 'Retraction');
  const retractionPubmedLink = createLinkElement(record.raw.RetractionPubMedID, 'https://pubmed.ncbi.nlm.nih.gov/', 'Retraction PubMed');

  if (retractionLink || retractionPubmedLink) {
    const row1 = document.createElement('div');
    row1.className = 'notice-card-link-row';
    if (retractionLink) row1.appendChild(retractionLink);
    if (retractionPubmedLink) row1.appendChild(retractionPubmedLink);
    links.appendChild(row1);
  }

  // Row 2: Original paper links
  const originalLink = createLinkElement(record.raw.OriginalPaperDOI, 'https://doi.org/', 'Original');
  const originalPubmedLink = createLinkElement(record.raw.OriginalPaperPubMedID, 'https://pubmed.ncbi.nlm.nih.gov/', 'Original PubMed');

  if (originalLink || originalPubmedLink) {
    const row2 = document.createElement('div');
    row2.className = 'notice-card-link-row';
    if (originalLink) row2.appendChild(originalLink);
    if (originalPubmedLink) row2.appendChild(originalPubmedLink);
    links.appendChild(row2);
  }

  if (links.children.length > 0) {
    card.appendChild(links);
  }

  return card;
}

function addField(container: HTMLElement, label: string, value?: string): void {
  if (!value || value.trim() === '') return;

  const field = document.createElement('div');
  field.className = 'notice-field';

  const labelEl = document.createElement('div');
  labelEl.className = 'notice-field-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('div');
  valueEl.className = 'notice-field-value';

  // Linkify URLs in text
  const linkedContent = linkifyText(value);
  valueEl.appendChild(linkedContent);

  field.appendChild(labelEl);
  field.appendChild(valueEl);
  container.appendChild(field);
}

function linkifyText(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  // Match URLs (http, https)
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/gi;

  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    // Add text before the URL
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    // Validate and add the URL as a link
    const urlStr = match[1];
    try {
      const url = new URL(urlStr);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.textContent = urlStr;
        fragment.appendChild(link);
      } else {
        fragment.appendChild(document.createTextNode(urlStr));
      }
    } catch {
      fragment.appendChild(document.createTextNode(urlStr));
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}

function createLinkElement(value?: string, prefix = '', text = 'View'): HTMLElement | null {
  if (!value || value.trim() === '' || /unavailable/i.test(value)) return null;

  const rawUrl = prefix ? `${prefix}${value.trim()}` : value.trim();

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const a = document.createElement('a');
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.className = 'notice-link';
  a.textContent = text + ' ';
  const parser = new DOMParser();
  const doc = parser.parseFromString(ICONS.externalLink.trim(), 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg && svg.nodeName === 'svg') {
    a.appendChild(a.ownerDocument.importNode(svg, true));
  }
  return a;
}

function showLoading(): void {
  loadingEl.hidden = false;
  clearMessage();
  showStatusHero('muted', ICONS.info, 'Checking...', '');
  clearChildren(noticesEl);
  noticesEl.hidden = true;
}

function renderError(message: string): void {
  hideLoading();
  setMessage(message, 'error');
  showStatusHero('warning', ICONS.alertTriangle, 'Error', '');
}

function renderDisabled(): void {
  hideLoading();
  clearMessage();
  showStatusHero('muted', ICONS.pause, 'Paused', 'Toggle on to resume checks');
}

function renderNoDoi(): void {
  hideLoading();
  clearMessage();
  showStatusHero('muted', ICONS.info, 'No DOI Detected', 'Navigate to an article page');
}

function renderUnsupported(): void {
  hideLoading();
  toggleEl.disabled = true;
  showStatusHero('muted', ICONS.info, 'Unsupported Website', '');

  messageEl.hidden = false;
  messageEl.className = 'message message--muted';
  messageEl.textContent = '';

  const note = document.createElement('p');
  note.textContent = 'This website is not on the supported list.';

  const actions = document.createElement('div');
  actions.className = 'unsupported-actions';

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

  const requestLink = document.createElement('a');
  requestLink.href = SITE_REQUEST_URL;
  requestLink.target = '_blank';
  requestLink.rel = 'noreferrer';
  requestLink.textContent = 'Request site support';
  requestLink.className = 'link';

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
  showStatusHero('warning', ICONS.clock, 'Rate Limited', `Retry ${retryText}`);
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
  button.textContent = 'Enabling...';
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
