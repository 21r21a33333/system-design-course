// scripts/ingest/images.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyImages, escapeLiteralBraces, quoteHtmlAttributes, rewriteImagePaths, selfCloseImgTags } from './images';

describe('images', () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-src-'));
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-dest-'));
    fs.writeFileSync(path.join(srcDir, 'foo.png'), 'fake-png-bytes');
    fs.writeFileSync(path.join(srcDir, 'bar.png'), 'fake-png-bytes');
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  it('copies every file and returns the filenames', () => {
    const copied = copyImages(srcDir, destDir);
    expect(copied.sort()).toEqual(['bar.png', 'foo.png']);
    expect(fs.existsSync(path.join(destDir, 'foo.png'))).toBe(true);
  });

  it('rewrites markdown and html image paths', () => {
    const md = rewriteImagePaths('![alt](images/foo.png)');
    expect(md).toBe('![alt](/img/sdp/foo.png)');
    const html = rewriteImagePaths('<img src="images/foo.png">');
    expect(html).toBe('<img src="/img/sdp/foo.png">');
  });

  it('prepends baseUrl to raw html img src but not to markdown image syntax', () => {
    // Docusaurus's remark plugin already resolves markdown ![]() image paths
    // against baseUrl automatically; prepending it here too would double it.
    // Raw HTML <img> tags get no such treatment from Docusaurus, so they need
    // baseUrl applied at ingestion time or they 404 under a non-root baseUrl.
    const md = rewriteImagePaths('![alt](images/foo.png)', '/system-design-course');
    expect(md).toBe('![alt](/img/sdp/foo.png)');
    const html = rewriteImagePaths('<img src="images/foo.png">', '/system-design-course');
    expect(html).toBe('<img src="/system-design-course/img/sdp/foo.png">');
  });

  it('strips a trailing slash from baseUrl before prepending', () => {
    const html = rewriteImagePaths('<img src="images/foo.png">', '/system-design-course/');
    expect(html).toBe('<img src="/system-design-course/img/sdp/foo.png">');
  });

  it('quotes unquoted html attribute values', () => {
    const out = quoteHtmlAttributes('<a href=https://example.com/page>text</a>');
    expect(out).toBe('<a href="https://example.com/page">text</a>');
  });

  it('leaves already-quoted attribute values unchanged', () => {
    const out = quoteHtmlAttributes('<a href="https://example.com/page">text</a>');
    expect(out).toBe('<a href="https://example.com/page">text</a>');
  });

  it('leaves JSX-expression attribute values unchanged', () => {
    const out = quoteHtmlAttributes('<Foo bar={baz}>text</Foo>');
    expect(out).toBe('<Foo bar={baz}>text</Foo>');
  });

  it('self-closes unclosed img tags', () => {
    const out = selfCloseImgTags('<img src="/img/sdp/foo.png">');
    expect(out).toBe('<img src="/img/sdp/foo.png" />');
  });

  it('leaves already-self-closed img tags unchanged', () => {
    const out = selfCloseImgTags('<img src="/img/sdp/foo.png" />');
    expect(out).toBe('<img src="/img/sdp/foo.png" />');
  });

  it('escapes literal braces outside code fences', () => {
    const out = escapeLiteralBraces('{<br/>"personid": "1234"<br/>}');
    expect(out).toBe('\\{<br/>"personid": "1234"<br/>\\}');
  });

  it('leaves braces inside fenced code blocks unescaped', () => {
    const body = ['```python', 'cache.get("user.{0}", user_id)', '```'].join('\n');
    expect(escapeLiteralBraces(body)).toBe(body);
  });
});
