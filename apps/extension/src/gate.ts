import Domains from './domains';

const DOMAIN_SET = new Set(Domains.getDomainList().map((d) => d.toLowerCase()));

const PATH_HINTS = [/\/doi\//i, /\/article\//i, /\/journals?\//i, /\/content\//i];

export function isSupportedLocation(u: Location = location): boolean {
  const href = u.href || `${u.protocol}//${u.host}${u.pathname}${u.search || ''}`;
  if (href && Domains.validate(href)) return true;

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
      const j = JSON.parse(s.textContent || 'null') as Record<string, unknown> | unknown[] | null;
      const items: unknown[] = Array.isArray(j) ? j : (j?.['@graph'] as unknown[]) || [j];
      if (items.some((it) => {
        const item = it as Record<string, unknown> | null;
        return /scholarlyarticle/i.test(String(item?.['@type'] ?? ''));
      })) return true;
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

type CleanupFunction = () => void;

export function hookSpaNavigation(onChange: () => void): CleanupFunction {
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

  // Debounced MutationObserver to avoid excessive callback invocations
  let mutationTimeout: ReturnType<typeof setTimeout> | null = null;
  const debouncedOnChange = () => {
    if (mutationTimeout) return;
    mutationTimeout = setTimeout(() => {
      mutationTimeout = null;
      onChange();
    }, 100);
  };

  // Watch for relevant DOM changes (meta tags, canonical links, JSON-LD scripts)
  // Using a more targeted approach than watching the entire subtree
  const observer = new MutationObserver(debouncedOnChange);
  observer.observe(document.head || document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['href', 'content', 'rel', 'name'],
  });

  // Return cleanup function to disconnect observer and remove listeners
  return () => {
    observer.disconnect();
    if (mutationTimeout) {
      clearTimeout(mutationTimeout);
      mutationTimeout = null;
    }
    window.removeEventListener('popstate', fire);
    window.removeEventListener('retractcheck:locationchange', fire);
    // Note: We intentionally don't restore history.pushState/replaceState
    // as other code may depend on the wrapped versions
  };
}
