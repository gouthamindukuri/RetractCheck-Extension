import {
  DOI_CORE,
  DOI_LABEL_PATTERN,
  DOI_PREFIX_PATTERN,
  PERCENT_COLON,
  PERCENT_SLASH,
  VIEW_TOKENS
} from './constants';

// Maximum input length to process - prevents excessive regex backtracking
const MAX_INPUT_LENGTH = 500;

/** Normalize a DOI: strips URL prefixes, labels, and view tokens; lowercases */
export function normaliseDoi(raw: unknown): string | null {
  if (!raw) return null;

  const rawStr = String(raw);
  // Early exit for excessively long inputs
  if (rawStr.length > MAX_INPUT_LENGTH) return null;

  const str = rawStr
    .trim()
    .replace(DOI_PREFIX_PATTERN, '')
    .replace(DOI_LABEL_PATTERN, '')
    .replace(PERCENT_SLASH, '/')
    .replace(PERCENT_COLON, ':');

  const hit = str.match(DOI_CORE);
  if (!hit) return null;

  let doi = hit[1].toLowerCase();
  const segs = doi.split('/');
  const lastSeg = segs[segs.length - 1];
  if (segs.length >= 3 && lastSeg && VIEW_TOKENS.has(lastSeg as typeof VIEW_TOKENS extends Set<infer T> ? T : never)) {
    segs.pop();
    doi = segs.join('/');
  }
  return doi;
}

/** Alias for normaliseDoi */
export const cleanDoi = normaliseDoi;

