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

export function rewriteInternalLinks(body: string, sections: SectionSpec[]): string {
  const anchorToSlug = new Map(sections.map((s) => [githubAnchor(s.heading), s.slug]));
  return body.replace(/]\(#([^)]+)\)/g, (full, anchor: string) => {
    const slug = anchorToSlug.get(anchor);
    return slug ? `](/docs/concepts/${slug})` : full;
  });
}
