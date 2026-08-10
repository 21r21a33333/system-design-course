// scripts/authored/frontmatter.ts
export function buildAuthoredFrontmatter(title: string, position: number): string {
  const escaped = title.replace(/"/g, '\\"');
  return `---\ntitle: "${escaped}"\nsidebar_position: ${position}\nsupplementary: true\n---\n\n`;
}
