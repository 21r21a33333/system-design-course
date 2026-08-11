// scripts/ingest/run.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONCEPT_SECTIONS,
  splitReadme,
  rewriteInternalLinks,
  buildReadmeAnchorMap,
  resolveRemainingAnchorsToGithub,
} from './splitReadme';
import { copyImages, escapeLiteralBraces, quoteHtmlAttributes, rewriteImagePaths, selfCloseImgTags } from './images';
import { buildFrontmatter } from './frontmatter';
import {
  SYSTEM_DESIGN_CASE_STUDIES,
  OOD_CASE_STUDIES,
  copySystemDesignCaseStudies,
  convertObjectOrientedNotebooks,
  rewriteReadmeCaseStudyLinks,
} from './caseStudies';
import { FLASHCARD_DECKS, extractAllDecks } from './flashcards';
import { buildManifest, writeManifestFile, type ManifestEntry } from './manifest';
import { scanAuthoredMarkdown } from '../authored/scanAuthoredDocs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Must match docusaurus.config.ts's `baseUrl`. Raw HTML <img> tags in the
// source content need this prepended manually (see images.ts) since
// Docusaurus only auto-applies baseUrl to markdown ![]() image syntax.
const SITE_BASE_URL = '/system-design-course';

function main(): void {
  const sourceRoot = process.argv[2];
  if (!sourceRoot) {
    throw new Error('Usage: npm run ingest -- <path-to-cloned-system-design-primer>');
  }

  const readme = fs.readFileSync(path.join(sourceRoot, 'README.md'), 'utf-8');

  // solutions/*/*.png files exist in the source repo but are unreferenced by
  // any README or notebook (verified during design) — intentionally skipped.
  const imageFiles = copyImages(path.join(sourceRoot, 'images'), path.join(REPO_ROOT, 'static', 'img', 'sdp'));

  const anchorMap = buildReadmeAnchorMap(readme, CONCEPT_SECTIONS);

  const [motivationBody] = [...splitReadme(readme, [{ heading: 'Motivation', slug: 'motivation', title: 'Motivation' }]).values()];
  const introBody = resolveRemainingAnchorsToGithub(
    rewriteInternalLinks(
      escapeLiteralBraces(selfCloseImgTags(quoteHtmlAttributes(rewriteImagePaths(motivationBody, SITE_BASE_URL)))),
      CONCEPT_SECTIONS,
      anchorMap,
    ),
  );
  fs.writeFileSync(
    path.join(REPO_ROOT, 'course', 'intro.md'),
    `${buildFrontmatter('Motivation', 1)}${introBody}\n\n---\n\nContent adapted from [donnemartin/system-design-primer](https://github.com/donnemartin/system-design-primer), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).\n`,
  );

  const conceptBodies = splitReadme(readme, CONCEPT_SECTIONS);
  const conceptsDir = path.join(REPO_ROOT, 'course', 'concepts');
  fs.mkdirSync(conceptsDir, { recursive: true });
  CONCEPT_SECTIONS.forEach((spec, index) => {
    const raw = conceptBodies.get(spec.slug)!;
    const withCaseStudyLinks = rewriteReadmeCaseStudyLinks(raw, SYSTEM_DESIGN_CASE_STUDIES);
    const body = resolveRemainingAnchorsToGithub(
      rewriteInternalLinks(
        escapeLiteralBraces(selfCloseImgTags(quoteHtmlAttributes(rewriteImagePaths(withCaseStudyLinks, SITE_BASE_URL)))),
        CONCEPT_SECTIONS,
        anchorMap,
      ),
    );
    fs.writeFileSync(path.join(conceptsDir, `${spec.slug}.md`), buildFrontmatter(spec.title, index + 1) + body + '\n');
  });

  copySystemDesignCaseStudies(sourceRoot, path.join(REPO_ROOT, 'course', 'case-studies', 'system-design'), SITE_BASE_URL);
  convertObjectOrientedNotebooks(sourceRoot, path.join(REPO_ROOT, 'course', 'case-studies', 'object-oriented-design'));

  const decks = extractAllDecks(path.join(sourceRoot, 'resources', 'flash_cards'));
  const flashcardsDir = path.join(REPO_ROOT, 'src', 'data', 'flashcards');
  fs.mkdirSync(flashcardsDir, { recursive: true });
  let totalCards = 0;
  for (const spec of FLASHCARD_DECKS) {
    const cards = decks[spec.deckId];
    totalCards += cards.length;
    fs.writeFileSync(path.join(flashcardsDir, `${spec.deckId}.json`), JSON.stringify(cards, null, 2));
  }

  const manifest: ManifestEntry[] = buildManifest(
    CONCEPT_SECTIONS.map((s) => ({ slug: s.slug, title: s.title })),
    SYSTEM_DESIGN_CASE_STUDIES.map((s) => ({ slug: s.slug, title: s.title })),
    OOD_CASE_STUDIES.map((s) => ({ slug: s.slug, title: s.title })),
    FLASHCARD_DECKS.map((d) => ({ deckId: d.deckId, title: d.title })),
  ).map((entry) => ({ ...entry, source: 'primer' as const }));

  const patternEntries = scanAuthoredMarkdown(path.join(REPO_ROOT, 'course'), 'patterns').map((p) => ({
    id: p.id,
    title: p.title,
    path: `/docs/${p.id}`,
    category: 'design-patterns' as const,
    source: 'supplementary' as const,
  }));
  manifest.push(...patternEntries);
  // course/intro.md is generated separately above (not part of CONCEPT_SECTIONS) but
  // still gets a Mark-as-complete toggle via the Task 8 DocItem swizzle, so it needs
  // a manifest entry to be counted toward dashboard progress and category lists.
  manifest.push({ id: 'intro', title: 'Motivation', path: '/docs/intro', category: 'concepts', source: 'primer' });
  writeManifestFile(manifest, path.join(REPO_ROOT, 'src', 'data', 'courseManifest.ts'));

  const expected = { concepts: 19, sdCaseStudies: 8, oodCaseStudies: 6, flashcards: 56, images: 36 };
  const actual = {
    concepts: CONCEPT_SECTIONS.length,
    sdCaseStudies: SYSTEM_DESIGN_CASE_STUDIES.length,
    oodCaseStudies: OOD_CASE_STUDIES.length,
    flashcards: totalCards,
    images: imageFiles.length,
  };
  console.log('Ingestion summary:', actual);
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Ingestion count mismatch for ${key}: expected ${expected[key]}, got ${actual[key]}`);
    }
  }

  const expectedPatternCount = 106;
  if (patternEntries.length !== expectedPatternCount) {
    throw new Error(
      `Supplementary pattern count mismatch: expected ${expectedPatternCount}, got ${patternEntries.length}`,
    );
  }

  console.log('All counts match expected inventory. Ingestion complete.');
}

main();
