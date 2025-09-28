import Domains from './domains';

const DOMAIN_LIB = Domains as any;

const DOMAIN_SET = new Set(DOMAIN_LIB.getDomainList().map((d: string) => d.toLowerCase()));

const PATH_HINTS = [/\/doi\//i, /\/article\//i, /\/journals?\//i, /\/content\//i];

export function inHostAllowList(u: Location = location): boolean {
  return isSupportedLocation(u);
}

export function isSupportedLocation(u: Location = location): boolean {
  const href = u.href || `${u.protocol}//${u.host}${u.pathname}${u.search || ''}`;
  if (href && DOMAIN_LIB.validate(href)) return true;

  const host = u.hostname.toLowerCase();
  if (DOMAIN_SET.has(host)) return true;

  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const variant = parts.slice(i).join('.');
    if (DOMAIN_SET.has(variant)) return true;
  }
  return false;
}

export function looksArticleLike(doc: Document = document): boolean {
  if (doc.querySelector('meta[name="citation_title"]')) return true;
  if (doc.querySelector('meta[name="citation_doi"]')) return true;

  const can = doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || '';
  if (/\/doi\/|10\.\d{4,9}\//i.test(can)) return true;

  try {
    for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
      const j = JSON.parse(s.textContent || 'null');
      const items = Array.isArray(j) ? j : j?.['@graph'] || [j];
      if (items.some((it: any) => /scholarlyarticle/i.test(it?.['@type'] || ''))) return true;
    }
  } catch {}
  return false;
}

export function shouldActivate(doc: Document = document): boolean {
  if (!isSupportedLocation()) return false;
  const path = (location.pathname || '') + (location.search || '');
  const pathLikely = PATH_HINTS.some((rx) => rx.test(path));
  return pathLikely || looksArticleLike(doc);
}

export function hookSpaNavigation(onChange: () => void): void {
  const fire = () => onChange();
  const ev = new Event('retractcheck:locationchange');
  const push = history.pushState.bind(history) as History['pushState'];
  const rep = history.replaceState.bind(history) as History['replaceState'];
  history.pushState = ((...args: Parameters<History['pushState']>) => {
    const r = push(...args);
    window.dispatchEvent(ev);
    return r;
  }) as History['pushState'];
  history.replaceState = ((...args: Parameters<History['replaceState']>) => {
    const r = rep(...args);
    window.dispatchEvent(ev);
    return r;
  }) as History['replaceState'];
  window.addEventListener('popstate', fire);
  window.addEventListener('retractcheck:locationchange', fire);
  new MutationObserver(() => onChange()).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['href', 'content'],
  });
}
