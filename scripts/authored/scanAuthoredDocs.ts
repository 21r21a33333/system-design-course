// scripts/authored/scanAuthoredDocs.ts
import fs from 'node:fs';
import path from 'node:path';

const TITLE_LINE = /^title:\s*"((?:[^"\\]|\\.)*)"\s*$/m;

function readTitle(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = TITLE_LINE.exec(raw);
  if (!match) {
    throw new Error(`scanAuthoredMarkdown: no frontmatter title found in ${filePath}`);
  }
  return match[1].replace(/\\"/g, '"');
}

function walk(dir: string, courseDir: string, out: { id: string; title: string }[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, courseDir, out);
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    const relativeNoExt = path.relative(courseDir, fullPath).replace(/\.md$/, '').split(path.sep).join('/');
    out.push({ id: relativeNoExt, title: readTitle(fullPath) });
  }
}

export function scanAuthoredMarkdown(courseDir: string, subDir: string): { id: string; title: string }[] {
  const target = path.join(courseDir, subDir);
  if (!fs.existsSync(target)) return [];
  const out: { id: string; title: string }[] = [];
  walk(target, courseDir, out);
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
