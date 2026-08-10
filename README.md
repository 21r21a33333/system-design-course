# System Design Course

A self-hosted, progress-trackable replica of
[donnemartin/system-design-primer](https://github.com/donnemartin/system-design-primer)
(CC BY 4.0), built with Docusaurus.

## Development

```bash
npm install
npm start
```

## Regenerating content from upstream

```bash
git clone --depth 1 https://github.com/donnemartin/system-design-primer.git /tmp/system-design-primer-src
npm run ingest -- /tmp/system-design-primer-src
```

## Supplementary pattern library

`course/patterns/**/*.md` contains 60 hand-authored pages covering
system-design patterns not present in the primer (Circuit Breaker, CQRS,
Saga, etc.), organized into 10 groups.

Every such page has `supplementary: true` in its frontmatter and is
visually marked with a "Supplementary — not from the original primer"
badge on the page and in the `/progress` dashboard, so primer-derived and
supplementary content stay clearly distinguishable.

`npm run ingest` also scans `course/patterns/**/*.md` (via
`scripts/authored/scanAuthoredDocs.ts`) and indexes it into the manifest
alongside the primer content — no separate command needed.

To add a new supplementary page, create the `.md` file with `title`,
`sidebar_position`, and `supplementary: true` frontmatter under the
appropriate `course/patterns/<group>/` folder, then re-run
`npm run ingest -- <path>` to pick it up.

## Tests

```bash
npm test
```
