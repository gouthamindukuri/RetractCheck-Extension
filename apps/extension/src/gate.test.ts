import { beforeEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';

const testWindow = new Window({ url: 'https://www.nature.com' });
Object.assign(globalThis, {
  window: testWindow,
  document: testWindow.document,
  MutationObserver: testWindow.MutationObserver,
  DOMParser: testWindow.DOMParser,
  history: testWindow.history,
  Event: testWindow.Event,
});

Object.defineProperty(globalThis, 'location', {
  value: testWindow.location,
  writable: true,
  configurable: true,
});

import {
  hookSpaNavigation,
  isSupportedLocation,
  looksArticleLike,
  shouldActivate,
} from './gate';

const allowedHost = 'www.nature.com';

function buildDocument(html: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc) throw new Error('failed to parse html');
  return doc;
}

describe('isSupportedLocation', () => {
  it('matches known scholarly domains', () => {
    const url = new URL('https://www.nature.com/articles/123');
    expect(isSupportedLocation(url as unknown as Location)).toBe(true);
  });

  it('rejects unrelated hosts', () => {
    const url = new URL('https://example.com/post');
    expect(isSupportedLocation(url as unknown as Location)).toBe(false);
  });
});

describe('looksArticleLike', () => {
  it('detects citation meta tags', () => {
    const doc = buildDocument('<meta name="citation_title" content="Paper" />');
    expect(looksArticleLike(doc)).toBe(true);
  });

  it('detects scholarlyArticle json-ld', () => {
    const doc = buildDocument(`
      <script type="application/ld+json">
        ${JSON.stringify({ '@graph': [{ '@type': 'ScholarlyArticle' }] })}
      </script>
    `);
    expect(looksArticleLike(doc)).toBe(true);
  });

  it('returns false for plain pages', () => {
    expect(looksArticleLike(buildDocument('<p>hello</p>'))).toBe(false);
  });
});

describe('shouldActivate', () => {
  it('activates when path hints match', () => {
    Object.defineProperty(globalThis, 'location', {
      value: new URL(`https://${allowedHost}/doi/full/10.1000/xyz`),
      configurable: true,
    });
    expect(shouldActivate(buildDocument('<p/>'))).toBe(true);
    delete (globalThis as unknown as Record<string, unknown>).location;
  });
});

describe('hookSpaNavigation', () => {
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    hookSpaNavigation(() => {
      calls += 1;
    });
  });

  it('fires on pushState and replaceState', () => {
    history.pushState({}, '', '/one');
    history.replaceState({}, '', '/two');
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
