import { describe, expect, it } from 'vitest';

import { extractPrimaryDoi } from './extract';

function createDocument(html: string): Document {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  if (!dom) throw new Error('failed to parse html');
  return dom;
}

describe('extractPrimaryDoi', () => {
  it('finds DOI in canonical link', () => {
    const doc = createDocument(`
      <html>
        <head>
          <link rel="canonical" href="https://example.com/doi/10.1000/xyz123" />
        </head>
      </html>
    `);
    expect(extractPrimaryDoi(doc)).toBe('10.1000/xyz123');
  });

  it('normalises DOI from JSON-LD identifier array', () => {
    const doc = createDocument(`
      <html>
        <head>
          <script type="application/ld+json">
            ${JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'ScholarlyArticle',
              identifier: [
                { '@type': 'PropertyValue', propertyID: 'DOI', value: 'https://doi.org/10.5555/abc-123' },
              ],
            })}
          </script>
        </head>
      </html>
    `);
    expect(extractPrimaryDoi(doc)).toBe('10.5555/abc-123');
  });

  it('ignores view tokens appended to DOI', () => {
    const doc = createDocument(`
      <html>
        <body>
          <a href="https://example.com/doi/10.1234/foo.bar/pdf">Download PDF</a>
        </body>
      </html>
    `);
    expect(extractPrimaryDoi(doc)).toBe('10.1234/foo.bar');
  });

  it('returns null when no DOI exists', () => {
    const doc = createDocument('<html><body><p>No DOI here</p></body></html>');
    expect(extractPrimaryDoi(doc)).toBeNull();
  });
});

