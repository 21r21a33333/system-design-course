// scripts/ingest/images.ts
import fs from 'node:fs';
import path from 'node:path';

export function copyImages(sourceImagesDir: string, destDir: string): string[] {
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs.readdirSync(sourceImagesDir).filter((f) => !f.startsWith('.'));
  for (const file of files) {
    fs.copyFileSync(path.join(sourceImagesDir, file), path.join(destDir, file));
  }
  return files;
}

const IMAGE_MARKDOWN = /(!\[[^\]]*]\()images\/([^)]+)(\))/g;
const IMAGE_HTML_SRC = /(<img[^>]*src=")images\/([^"]+)(")/g;

export function rewriteImagePaths(body: string): string {
  return body.replace(IMAGE_MARKDOWN, '$1/img/sdp/$2$3').replace(IMAGE_HTML_SRC, '$1/img/sdp/$2$3');
}
