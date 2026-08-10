import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest, writeManifestFile } from './manifest';

describe('buildManifest', () => {
  it('builds one entry per input item with the right id/path/category shape', () => {
    const entries = buildManifest(
      [{ slug: 'database', title: 'Database' }],
      [{ slug: 'pastebin', title: 'Design Pastebin.com (or Bit.ly)' }],
      [{ slug: 'lru-cache', title: 'Design an LRU Cache' }],
      [{ deckId: 'system-design', title: 'System Design' }],
    );
    expect(entries).toEqual([
      { id: 'concepts/database', title: 'Database', path: '/docs/concepts/database', category: 'concepts' },
      {
        id: 'case-studies/system-design/pastebin',
        title: 'Design Pastebin.com (or Bit.ly)',
        path: '/docs/case-studies/system-design/pastebin',
        category: 'system-design-case-studies',
      },
      {
        id: 'case-studies/object-oriented-design/lru-cache',
        title: 'Design an LRU Cache',
        path: '/docs/case-studies/object-oriented-design/lru-cache',
        category: 'oo-case-studies',
      },
      {
        id: 'flashcards/system-design',
        title: 'System Design',
        path: '/flashcards/system-design',
        category: 'flashcards',
      },
    ]);
  });
});

describe('writeManifestFile', () => {
  let outFile: string;

  afterEach(() => {
    if (outFile) fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  });

  it('writes a TypeScript module exporting courseManifest', () => {
    outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-manifest-')), 'courseManifest.ts');
    writeManifestFile([{ id: 'a', title: 'A', path: '/docs/a', category: 'concepts' }], outFile);
    const content = fs.readFileSync(outFile, 'utf-8');
    expect(content).toContain('export const courseManifest');
    expect(content).toContain('"id": "a"');
  });
});
