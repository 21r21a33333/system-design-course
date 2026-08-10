// scripts/ingest/images.ts
import fs from 'node:fs';
import path from 'node:path';

export function copyImages(sourceImagesDir: string, destDir: string): string[] {
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs.readdirSync(sourceImagesDir).filter((f) => !f.startsWith('.'));
  for (const file of files) {
    fs.copyFileSync(path.join(sourceImagesDir, file), path.join(destDir, file));
  }
  return files;
}

const IMAGE_MARKDOWN = /(!\[[^\]]*]\()images\/([^)]+)(\))/g;
const IMAGE_HTML_SRC = /(<img[^>]*src=")images\/([^"]+)(")/g;

// Docusaurus's own remark plugin resolves a leading-slash path in markdown
// `![]()` syntax against `baseUrl` automatically (and bundles it via
// webpack) — so those paths must stay baseUrl-free here. Raw HTML `<img
// src="">` tags are NOT processed by that plugin (documented Docusaurus
// behavior: only markdown image syntax gets baseUrl-aware resolution), so
// without baseUrl prepended here they 404 under any non-root baseUrl (e.g.
// GitHub Pages project sites, which are always served under
// `/<repo-name>/`). `baseUrl` defaults to '' so callers that don't pass it
// (and existing tests) keep the prior root-baseUrl-only behavior.
export function rewriteImagePaths(body: string, baseUrl: string = ''): string {
  const base = baseUrl.replace(/\/$/, '');
  return body
    .replace(IMAGE_MARKDOWN, '$1/img/sdp/$2$3')
    .replace(IMAGE_HTML_SRC, `$1${base}/img/sdp/$2$3`);
}

// Source README/case-study markdown contains raw HTML tags with unquoted
// attribute values (e.g. `<a href=https://example.com>`), which is valid
// GitHub-flavored markdown/HTML but not valid MDX/JSX — Docusaurus's MDX
// compiler rejects it. Quoting the value is a no-op for rendered output, so
// this preserves content fidelity while making the markup MDX-compatible.
const UNQUOTED_HTML_ATTR = /(<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z-]+="[^"]*")*\s+[a-zA-Z-]+=)([^"'{\s>][^\s>]*)/g;

export function quoteHtmlAttributes(body: string): string {
  return body.replace(UNQUOTED_HTML_ATTR, '$1"$2"');
}

// Source markdown uses HTML5 void-element syntax (`<img ...>`, no closing
// tag), which is valid HTML but invalid JSX — MDX requires void elements to
// be self-closed (`<img ... />`). Self-closing is a no-op for rendered
// output, so this preserves content fidelity while making the markup
// MDX-compatible.
const UNCLOSED_IMG_TAG = /<img((?:[^>]*[^/])?)>/g;

export function selfCloseImgTags(body: string): string {
  return body.replace(UNCLOSED_IMG_TAG, '<img$1 />');
}

// Source markdown (e.g. inline JSON snippets in prose/table cells) contains
// literal `{`/`}` outside of fenced code blocks. MDX parses `{...}` as a JS
// expression, so unescaped braces there cause a parse error. Backslash-
// escaping (`\{`, `\}`) is MDX's documented way to render a literal brace and
// is a no-op for rendered output. Braces inside fenced code blocks are left
// untouched — MDX already treats fenced code as literal text.
const FENCE_LINE = /^\s*```/;

export function escapeLiteralBraces(body: string): string {
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(/([{}])/g, '\\$1');
    })
    .join('\n');
}
