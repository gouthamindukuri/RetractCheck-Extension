import { cleanDoi } from './normalize';

function fromUrlPath(doc: Document = document): string | null {
  return cleanDoi(doc.location?.pathname ?? (typeof location !== 'undefined' ? location.pathname : ''));
}

function fromCanonical(doc: Document = document): string | null {
  const href =
    doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ||
    doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content ||
    '';
  return cleanDoi(href);
}

function fromMeta(doc: Document = document): string | null {
  const names = ['citation_doi', 'dc.identifier', 'DC.Identifier', 'dcterms.identifier', 'prism.doi', 'doi'];
  for (const n of names) {
    const el = doc.querySelector<HTMLMetaElement>(`meta[name="${n}"]`);
    const d = cleanDoi(el?.content);
    if (d) return d;
  }
  return null;
}

function fromJsonLd(doc: Document = document): string | null {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent || 'null');
      const items = Array.isArray(data) ? data : data?.['@graph'] || [data];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const take = (v: any): string | null => {
          if (typeof v === 'string') return cleanDoi(v);
          if (v && typeof v === 'object') {
            const pid = String(v.propertyID || v.propertyId || v['@type'] || '').toLowerCase();
            if (pid === 'doi') return cleanDoi(v.value || v.id || v['@id']);
          }
          return null;
        };
        let d = take((it as any).identifier);
        if (d) return d;
        const id = (it as any).identifier;
        if (Array.isArray(id)) {
          for (const v of id) {
            d = take(v);
            if (d) return d;
          }
        }
      }
    } catch {
      // ignore JSON parse errors
    }
  }
  return null;
}

function fromHeaderLink(doc: Document = document): string | null {
  const header =
    doc.querySelector('header, .article__header, .article-header, .ArticleHeader, #articleHeader, .highwire-article-citation') ||
    doc;
  const a = header.querySelector<HTMLAnchorElement>(
    'a[href*="/doi/10."], a[href*="/articles/10."], a[href*="doi.org/10."]'
  );
  return cleanDoi(a?.href);
}

export function extractPrimaryDoi(doc: Document = document): string | null {
  return fromUrlPath(doc) || fromCanonical(doc) || fromMeta(doc) || fromJsonLd(doc) || fromHeaderLink(doc) || null;
}

