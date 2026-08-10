// scripts/ingest/images.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyImages, rewriteImagePaths } from './images';

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
});
