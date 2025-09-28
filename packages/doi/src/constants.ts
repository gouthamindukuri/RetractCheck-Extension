export const DOI_CORE = /(10\.[0-9]{4,9}\/[\w.!$&'()*+,;=:@\/-]+)/i;

export const VIEW_TOKENS = new Set(
  [
    'full',
    'pdf',
    'epdf',
    'abs',
    'abstract',
    'html',
    'xml',
    'figures',
    'tables',
    'metrics',
    'references',
    'citedby',
    'reprint',
    'suppl',
    'supplementary',
    'supplementary-material',
    'download',
    'view',
    'reader'
  ] as const
);

export const DOI_PREFIX_PATTERN = /^https?:\/\/(dx\.)?doi\.org\//i;
export const DOI_LABEL_PATTERN = /^doi:\s*/i;
export const PERCENT_SLASH = /%2F/gi;
export const PERCENT_COLON = /%3A/gi;

export const SEVERITY = {
  none: 0,
  correction: 1,
  expression_of_concern: 2,
  retracted: 3
} as const;

export type SeverityKey = keyof typeof SEVERITY;

