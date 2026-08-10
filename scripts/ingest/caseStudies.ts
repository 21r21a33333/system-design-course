import fs from 'node:fs';
import path from 'node:path';
import { buildFrontmatter } from './frontmatter';
import { escapeLiteralBraces, quoteHtmlAttributes, rewriteImagePaths, selfCloseImgTags } from './images';

export interface CaseStudySpec {
  dir: string; // source directory name under solutions/<category>/
  slug: string;
  title: string;
}

export const SYSTEM_DESIGN_CASE_STUDIES: CaseStudySpec[] = [
  { dir: 'pastebin', slug: 'pastebin', title: 'Design Pastebin.com (or Bit.ly)' },
  { dir: 'twitter', slug: 'twitter', title: 'Design the Twitter Timeline and Search' },
  { dir: 'web_crawler', slug: 'web-crawler', title: 'Design a Web Crawler' },
  { dir: 'mint', slug: 'mint', title: 'Design Mint.com' },
  { dir: 'social_graph', slug: 'social-graph', title: 'Design the Data Structures for a Social Network' },
  { dir: 'query_cache', slug: 'query-cache', title: 'Design a Key-Value Cache for Web Server Query Results' },
  { dir: 'sales_rank', slug: 'sales-rank', title: "Design Amazon's Sales Rank by Category Feature" },
  { dir: 'scaling_aws', slug: 'scaling-aws', title: 'Design a System That Scales to Millions of Users on AWS' },
];

export const OOD_CASE_STUDIES: CaseStudySpec[] = [
  { dir: 'deck_of_cards', slug: 'deck-of-cards', title: 'Design a Deck of Cards' },
  { dir: 'call_center', slug: 'call-center', title: 'Design a Call Center' },
  { dir: 'lru_cache', slug: 'lru-cache', title: 'Design an LRU Cache' },
  { dir: 'hash_table', slug: 'hash-table', title: 'Design a Hashmap' },
  { dir: 'parking_lot', slug: 'parking-lot', title: 'Design a Parking Lot' },
  { dir: 'online_chat', slug: 'online-chat', title: 'Design Online Chat' },
];

const SIBLING_LINK = /]\(\.\.\/([a-z_]+)\/README\.md\)/g;

export function rewriteSiblingCaseStudyLinks(body: string, specs: CaseStudySpec[]): string {
  const dirToSlug = new Map(specs.map((s) => [s.dir, s.slug]));
  return body.replace(SIBLING_LINK, (full, dir: string) => {
    const slug = dirToSlug.get(dir);
    return slug ? `](/docs/case-studies/system-design/${slug})` : full;
  });
}

// The top-level README (now split into course/concepts/*) links into case
// study solutions as `solutions/system_design/<dir>/README.md`, relative to
// the repo root — a different link shape than the sibling-to-sibling links
// within solutions/ handled above.
const README_CASE_STUDY_LINK = /]\(solutions\/system_design\/([a-z_]+)\/README\.md\)/g;

export function rewriteReadmeCaseStudyLinks(body: string, specs: CaseStudySpec[]): string {
  const dirToSlug = new Map(specs.map((s) => [s.dir, s.slug]));
  return body.replace(README_CASE_STUDY_LINK, (full, dir: string) => {
    const slug = dirToSlug.get(dir);
    return slug ? `](/docs/case-studies/system-design/${slug})` : full;
  });
}

export function copySystemDesignCaseStudies(sourceRoot: string, outDir: string): CaseStudySpec[] {
  fs.mkdirSync(outDir, { recursive: true });
  SYSTEM_DESIGN_CASE_STUDIES.forEach((spec, index) => {
    const srcFile = path.join(sourceRoot, 'solutions', 'system_design', spec.dir, 'README.md');
    if (!fs.existsSync(srcFile)) {
      throw new Error(`copySystemDesignCaseStudies: missing ${srcFile}`);
    }
    const raw = fs.readFileSync(srcFile, 'utf-8');
    const withImages = escapeLiteralBraces(selfCloseImgTags(quoteHtmlAttributes(rewriteImagePaths(raw))));
    const withLinks = rewriteSiblingCaseStudyLinks(withImages, SYSTEM_DESIGN_CASE_STUDIES);
    fs.writeFileSync(path.join(outDir, `${spec.slug}.md`), buildFrontmatter(spec.title, index + 1) + withLinks + '\n');
  });
  return SYSTEM_DESIGN_CASE_STUDIES;
}

export interface NotebookCell {
  cell_type: 'markdown' | 'code';
  source: string[];
}

export interface Notebook {
  cells: NotebookCell[];
}

export function notebookToMarkdown(notebook: Notebook): string {
  return notebook.cells
    .map((cell) => {
      const text = cell.source.join('');
      return cell.cell_type === 'code' ? `\`\`\`python\n${text}\n\`\`\`` : text;
    })
    .join('\n\n');
}

// The object-oriented-design solutions are Jupyter notebooks (.ipynb), not
// README.md files — confirmed by inspecting the upstream repo during design.
export function convertObjectOrientedNotebooks(sourceRoot: string, outDir: string): CaseStudySpec[] {
  fs.mkdirSync(outDir, { recursive: true });
  OOD_CASE_STUDIES.forEach((spec, index) => {
    const dir = path.join(sourceRoot, 'solutions', 'object_oriented_design', spec.dir);
    const notebookFile = fs.readdirSync(dir).find((f) => f.endsWith('.ipynb'));
    if (!notebookFile) {
      throw new Error(`convertObjectOrientedNotebooks: no .ipynb found in ${dir}`);
    }
    const notebook: Notebook = JSON.parse(fs.readFileSync(path.join(dir, notebookFile), 'utf-8'));
    const body = notebookToMarkdown(notebook);
    fs.writeFileSync(path.join(outDir, `${spec.slug}.md`), buildFrontmatter(spec.title, index + 1) + body + '\n');
  });
  return OOD_CASE_STUDIES;
}
