import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import sanitizeHtml from 'sanitize-html';

export interface Flashcard {
  id: number;
  front: string;
  back: string;
}

export interface FlashcardDeckSpec {
  file: string; // .apkg filename under resources/flash_cards/
  deckId: string;
  title: string;
}

export const FLASHCARD_DECKS: FlashcardDeckSpec[] = [
  { file: 'System Design.apkg', deckId: 'system-design', title: 'System Design' },
  { file: 'System Design Exercises.apkg', deckId: 'system-design-exercises', title: 'System Design Exercises' },
  { file: 'OO Design.apkg', deckId: 'oo-design', title: 'OO Design' },
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'code', 'pre', 'br', 'span', 'blockquote'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https'],
};

export function sanitizeCardField(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim();
}

interface NoteRow {
  id: number;
  flds: string;
}

export function extractDeck(apkgPath: string): Flashcard[] {
  const zip = new AdmZip(apkgPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-anki-'));
  zip.extractAllTo(tmpDir, true);
  const dbFile = fs.existsSync(path.join(tmpDir, 'collection.anki21'))
    ? path.join(tmpDir, 'collection.anki21')
    : path.join(tmpDir, 'collection.anki2');

  const db = new Database(dbFile, { readonly: true });
  const rows = db.prepare('SELECT id, flds FROM notes ORDER BY id').all() as NoteRow[];
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return rows.map(({ id, flds }) => {
    const fields = flds.split('\x1f');
    return {
      id,
      front: sanitizeCardField(fields[0] ?? ''),
      back: sanitizeCardField(fields[1] ?? ''),
    };
  });
}

export function extractAllDecks(flashCardsDir: string): Record<string, Flashcard[]> {
  const out: Record<string, Flashcard[]> = {};
  for (const spec of FLASHCARD_DECKS) {
    const cards = extractDeck(path.join(flashCardsDir, spec.file));
    if (cards.length === 0) {
      throw new Error(`extractAllDecks: deck "${spec.file}" produced 0 cards`);
    }
    out[spec.deckId] = cards;
  }
  return out;
}
