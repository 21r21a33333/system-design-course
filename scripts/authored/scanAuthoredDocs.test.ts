// scripts/authored/scanAuthoredDocs.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAuthoredMarkdown } from './scanAuthoredDocs';

describe('scanAuthoredMarkdown', () => {
  let courseDir: string;

  beforeEach(() => {
    courseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-authored-'));
  });

  afterEach(() => {
    fs.rmSync(courseDir, { recursive: true, force: true });
  });

  it('returns id (path relative to courseDir, no extension) and title per file', () => {
    const groupDir = path.join(courseDir, 'patterns', 'communication');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'pub-sub.md'),
      '---\ntitle: "Publish-Subscribe"\nsidebar_position: 1\nsupplementary: true\n---\n\nBody.\n',
    );
    const entries = scanAuthoredMarkdown(courseDir, 'patterns');
    expect(entries).toEqual([{ id: 'patterns/communication/pub-sub', title: 'Publish-Subscribe' }]);
  });

  it('recurses through nested group subdirectories and sorts by id', () => {
    fs.mkdirSync(path.join(courseDir, 'patterns', 'b-group'), { recursive: true });
    fs.mkdirSync(path.join(courseDir, 'patterns', 'a-group'), { recursive: true });
    fs.writeFileSync(path.join(courseDir, 'patterns', 'b-group', 'z.md'), '---\ntitle: "Z"\n---\n\nBody.\n');
    fs.writeFileSync(path.join(courseDir, 'patterns', 'a-group', 'y.md'), '---\ntitle: "Y"\n---\n\nBody.\n');
    const entries = scanAuthoredMarkdown(courseDir, 'patterns');
    expect(entries).toEqual([
      { id: 'patterns/a-group/y', title: 'Y' },
      { id: 'patterns/b-group/z', title: 'Z' },
    ]);
  });

  it('ignores non-markdown files like _category_.json', () => {
    const groupDir = path.join(courseDir, 'patterns', 'communication');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '_category_.json'), '{"label":"Communication","position":1}');
    fs.writeFileSync(path.join(groupDir, 'pub-sub.md'), '---\ntitle: "Publish-Subscribe"\n---\n\nBody.\n');
    const entries = scanAuthoredMarkdown(courseDir, 'patterns');
    expect(entries).toEqual([{ id: 'patterns/communication/pub-sub', title: 'Publish-Subscribe' }]);
  });

  it('throws when a markdown file has no title in its frontmatter', () => {
    const groupDir = path.join(courseDir, 'patterns', 'communication');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'broken.md'), '---\nsidebar_position: 1\n---\n\nBody.\n');
    expect(() => scanAuthoredMarkdown(courseDir, 'patterns')).toThrow(/broken\.md/);
  });

  it('returns an empty array when subDir does not exist yet', () => {
    expect(scanAuthoredMarkdown(courseDir, 'patterns')).toEqual([]);
  });
});
