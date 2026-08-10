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

## Tests

```bash
npm test
```
