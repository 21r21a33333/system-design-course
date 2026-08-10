// scripts/ingest/frontmatter.ts
export function buildFrontmatter(title: string, position: number): string {
  const escaped = title.replace(/"/g, '\\"');
  return `---\ntitle: "${escaped}"\nsidebar_position: ${position}\n---\n\n`;
}
