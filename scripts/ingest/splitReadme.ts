// scripts/ingest/splitReadme.ts
export interface SectionSpec {
  heading: string; // exact "## " heading text to match in the source README
  slug: string; // output filename slug
  title: string; // frontmatter display title
}

// Order here is the sidebar order in course/concepts/.
export const CONCEPT_SECTIONS: SectionSpec[] = [
  { heading: 'Study guide', slug: 'study-guide', title: 'Study Guide' },
  {
    heading: 'How to approach a system design interview question',
    slug: 'interview-approach',
    title: 'How to Approach a System Design Interview Question',
  },
  { heading: 'System design topics: start here', slug: 'start-here', title: 'System Design Topics: Start Here' },
  { heading: 'Performance vs scalability', slug: 'performance-vs-scalability', title: 'Performance vs Scalability' },
  { heading: 'Latency vs throughput', slug: 'latency-vs-throughput', title: 'Latency vs Throughput' },
  { heading: 'Availability vs consistency', slug: 'availability-vs-consistency', title: 'Availability vs Consistency' },
  { heading: 'Consistency patterns', slug: 'consistency-patterns', title: 'Consistency Patterns' },
  { heading: 'Availability patterns', slug: 'availability-patterns', title: 'Availability Patterns' },
  { heading: 'Domain name system', slug: 'dns', title: 'Domain Name System' },
  { heading: 'Content delivery network', slug: 'cdn', title: 'Content Delivery Network' },
  { heading: 'Load balancer', slug: 'load-balancer', title: 'Load Balancer' },
  { heading: 'Reverse proxy (web server)', slug: 'reverse-proxy', title: 'Reverse Proxy' },
  { heading: 'Application layer', slug: 'application-layer', title: 'Application Layer' },
  { heading: 'Database', slug: 'database', title: 'Database' },
  { heading: 'Cache', slug: 'cache', title: 'Cache' },
  { heading: 'Asynchronism', slug: 'asynchronism', title: 'Asynchronism' },
  { heading: 'Communication', slug: 'communication', title: 'Communication' },
  { heading: 'Security', slug: 'security', title: 'Security' },
  { heading: 'Appendix', slug: 'appendix', title: 'Appendix' },
];

export function splitReadme(readmeContent: string, sections: SectionSpec[]): Map<string, string> {
  const lines = readmeContent.split('\n');
  const headingIndices: { index: number; heading: string }[] = [];
  lines.forEach((line, index) => {
    const match = /^## (.+)$/.exec(line.trim());
    if (match) headingIndices.push({ index, heading: match[1].trim() });
  });

  const bodies = new Map<string, string>();
  for (const spec of sections) {
    const found = headingIndices.findIndex((h) => h.heading === spec.heading);
    if (found === -1) {
      throw new Error(`splitReadme: heading "${spec.heading}" not found in README`);
    }
    const start = headingIndices[found].index + 1;
    const end = found + 1 < headingIndices.length ? headingIndices[found + 1].index : lines.length;
    bodies.set(spec.slug, lines.slice(start, end).join('\n').trim());
  }
  return bodies;
}

export function githubAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Maps every #anchor in the source README (top-level `##` section headings
// AND their `###`/`####` sub-headings) to the concept page slug that section
// ends up on, so cross-page anchors (e.g. `#cap-theorem`, defined under
// "Availability vs consistency" but linked to from other sections) resolve
// correctly after the README is split into separate pages. Headings whose
// enclosing top-level section isn't one of `sections` (e.g. "Contributing",
// "Index of system design topics" — deliberately not ingested as pages) are
// omitted; links to them are left untouched by rewriteInternalLinks.
export function buildReadmeAnchorMap(readmeContent: string, sections: SectionSpec[]): Map<string, string> {
  const headingToSlug = new Map(sections.map((s) => [s.heading, s.slug]));
  const anchorToSlug = new Map<string, string>();
  let currentSlug: string | undefined;
  for (const line of readmeContent.split('\n')) {
    const match = /^(#{2,4}) (.+)$/.exec(line.trim());
    if (!match) continue;
    const [, hashes, text] = match;
    if (hashes === '##') {
      currentSlug = headingToSlug.get(text.trim());
    }
    if (currentSlug) {
      anchorToSlug.set(githubAnchor(text.trim()), currentSlug);
    }
  }
  return anchorToSlug;
}

export function rewriteInternalLinks(body: string, sections: SectionSpec[], anchorMap?: Map<string, string>): string {
  const anchorToSlug = anchorMap ?? new Map(sections.map((s) => [githubAnchor(s.heading), s.slug]));
  return body.replace(/]\(#([^)]+)\)/g, (full, anchor: string) => {
    const slug = anchorToSlug.get(anchor);
    return slug ? `](/docs/concepts/${slug})` : full;
  });
}

const README_URL = 'https://github.com/donnemartin/system-design-primer/blob/main/README.md';

// A handful of #anchor links in the source README point at sections that
// were deliberately not ingested as pages (e.g. "Contributing", "Index of
// system design topics" — meta content and a table-of-contents made
// redundant by the Docusaurus sidebar). Rather than leave those as
// unresolvable same-page anchors (which fails Docusaurus's onBrokenAnchors
// check) or fabricate a local page for them, point them at the same section
// on the upstream GitHub README — honest about what's out of scope here
// without dropping the reference.
export function resolveRemainingAnchorsToGithub(body: string): string {
  return body.replace(/]\(#([^)]+)\)/g, (_full, anchor: string) => `](${README_URL}#${anchor})`);
}
