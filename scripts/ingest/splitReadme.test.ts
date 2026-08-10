// scripts/ingest/splitReadme.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildReadmeAnchorMap,
  splitReadme,
  githubAnchor,
  rewriteInternalLinks,
  resolveRemainingAnchorsToGithub,
  type SectionSpec,
} from './splitReadme';

const FAKE_README = `# Title

## Motivation

Intro text.

## Foo Bar

Foo body line one.
Foo body line two.

See [other](#baz-qux) for more.

### Foo Sub-heading

Nested content, cross-referenced from other sections.

## Baz Qux

Baz body.

## Contributing

Not ingested as a page.
`;

describe('splitReadme', () => {
  const sections: SectionSpec[] = [
    { heading: 'Foo Bar', slug: 'foo-bar', title: 'Foo Bar' },
    { heading: 'Baz Qux', slug: 'baz-qux', title: 'Baz Qux' },
  ];

  it('extracts each section body up to the next top-level heading', () => {
    const bodies = splitReadme(FAKE_README, sections);
    expect(bodies.get('foo-bar')).toBe(
      'Foo body line one.\nFoo body line two.\n\nSee [other](#baz-qux) for more.\n\n### Foo Sub-heading\n\nNested content, cross-referenced from other sections.',
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

  it('rewrites a sub-heading anchor using a supplied full README anchor map', () => {
    const allSections: SectionSpec[] = [
      { heading: 'Foo Bar', slug: 'foo-bar', title: 'Foo Bar' },
      { heading: 'Baz Qux', slug: 'baz-qux', title: 'Baz Qux' },
    ];
    const anchorMap = buildReadmeAnchorMap(FAKE_README, allSections);
    const out = rewriteInternalLinks('See [sub](#foo-sub-heading) for detail.', allSections, anchorMap);
    expect(out).toBe('See [sub](/docs/concepts/foo-bar) for detail.');
  });
});

describe('buildReadmeAnchorMap', () => {
  const sections: SectionSpec[] = [
    { heading: 'Foo Bar', slug: 'foo-bar', title: 'Foo Bar' },
    { heading: 'Baz Qux', slug: 'baz-qux', title: 'Baz Qux' },
  ];

  it('maps a top-level heading anchor to its own page', () => {
    const map = buildReadmeAnchorMap(FAKE_README, sections);
    expect(map.get('baz-qux')).toBe('baz-qux');
  });

  it('maps a sub-heading anchor to the page of its enclosing top-level section', () => {
    const map = buildReadmeAnchorMap(FAKE_README, sections);
    expect(map.get('foo-sub-heading')).toBe('foo-bar');
  });

  it('omits headings under a top-level section that is not in the ingested sections list', () => {
    const map = buildReadmeAnchorMap(FAKE_README, sections);
    expect(map.has('contributing')).toBe(false);
    expect(map.has('motivation')).toBe(false);
  });
});

describe('resolveRemainingAnchorsToGithub', () => {
  it('rewrites a leftover #anchor link to the upstream GitHub README', () => {
    const out = resolveRemainingAnchorsToGithub('See [contribute](#contributing) for details.');
    expect(out).toBe(
      'See [contribute](https://github.com/donnemartin/system-design-primer/blob/main/README.md#contributing) for details.',
    );
  });
});
