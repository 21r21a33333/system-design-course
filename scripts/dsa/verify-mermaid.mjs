// One-off verification script: parses every ```mermaid block in course/ with
// the exact `mermaid` package the site bundles, catching real parse errors
// (like the &#38; entity bug) that a plain `docusaurus build` won't catch,
// since mermaid parses/renders client-side at runtime, not at MDX build time.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
// Node 24 ships a built-in read-only global.navigator; override it via
// defineProperty since a plain assignment throws.
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.self = dom.window;
global.window.matchMedia = global.window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {},
}));

const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false });

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = walk('course');
let total = 0, failed = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m, idx = 0;
  while ((m = re.exec(text))) {
    idx++;
    total++;
    const block = m[1];
    try {
      await mermaid.parse(block);
    } catch (e) {
      failed++;
      console.log(`\n===== FAIL ${f} [block ${idx}] =====`);
      console.log(String(e.message || e));
      console.log('--- block content ---');
      console.log(block);
    }
  }
}
console.log(`\n${total} mermaid blocks checked across ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
