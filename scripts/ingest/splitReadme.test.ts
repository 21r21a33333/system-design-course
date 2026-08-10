// scripts/ingest/splitReadme.test.ts
import { describe, expect, it } from 'vitest';
import { splitReadme, githubAnchor, rewriteInternalLinks, type SectionSpec } from './splitReadme';

const FAKE_README = `# Title

## Motivation

Intro text.

## Foo Bar

Foo body line one.
Foo body line two.

See [other](#baz-qux) for more.

## Baz Qux

Baz body.
`;

describe('splitReadme', () => {
  const sections: SectionSpec[] = [
    { heading: 'Foo Bar', slug: 'foo-bar', title: 'Foo Bar' },
    { heading: 'Baz Qux', slug: 'baz-qux', title: 'Baz Qux' },
  ];

  it('extracts each section body up to the next top-level heading', () => {
    const bodies = splitReadme(FAKE_README, sections);
    expect(bodies.get('foo-bar')).toBe(
      'Foo body line one.\nFoo body line two.\n\nSee [other](#baz-qux) for more.',
    );
    expect(bodies.get('baz-qux')).toBe('Baz body.');
  });

  it('throws when a requested heading is missing', () => {
    const missing: SectionSpec[] = [{ heading: 'Nope', slug: 'nope', title: 'Nope' }];
    expect(() => splitReadme(FAKE_README, missing)).toThrow(/Nope/);
  });
});

describe('githubAnchor', () => {
  it('slugifies the way GitHub does', () => {
    expect(githubAnchor('Foo Bar')).toBe('foo-bar');
    expect(githubAnchor('Reverse proxy (web server)')).toBe('reverse-proxy-web-server');
  });
});

describe('rewriteInternalLinks', () => {
  const sections: SectionSpec[] = [{ heading: 'Baz Qux', slug: 'baz-qux', title: 'Baz Qux' }];

  it('rewrites a known #anchor link to a cross-doc path', () => {
    const out = rewriteInternalLinks('See [other](#baz-qux) for more.', sections);
    expect(out).toBe('See [other](/docs/concepts/baz-qux) for more.');
  });

  it('leaves unknown anchors untouched', () => {
    const out = rewriteInternalLinks('See [x](#unrelated-anchor).', sections);
    expect(out).toBe('See [x](#unrelated-anchor).');
  });
});
