import {
  DOI_CORE,
  DOI_LABEL_PATTERN,
  DOI_PREFIX_PATTERN,
  PERCENT_COLON,
  PERCENT_SLASH,
  VIEW_TOKENS
} from './constants';

export function cleanDoi(raw: unknown): string | null {
  if (!raw) return null;

  const str = String(raw)
    .trim()
    .replace(DOI_PREFIX_PATTERN, '')
    .replace(DOI_LABEL_PATTERN, '')
    .replace(PERCENT_SLASH, '/')
    .replace(PERCENT_COLON, ':');

  const hit = str.match(DOI_CORE);
  if (!hit) return null;

  let doi = hit[1].toLowerCase();
  const segs = doi.split('/');
  if (segs.length >= 3 && VIEW_TOKENS.has(segs[segs.length - 1] as any)) {
    segs.pop();
    doi = segs.join('/');
  }
  return doi;
}

export function normaliseDoi(raw: unknown): string | null {
  return cleanDoi(raw);
}

