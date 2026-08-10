// src/pages/progress.tsx
import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import { useProgress, computeCompletionPercent } from '@site/src/lib/progress';
import { courseManifest, type ManifestCategory, type ManifestEntry } from '@site/src/data/courseManifest';
import { FLASHCARD_DECK_CARDS } from '@site/src/data/flashcardDecks';

const CATEGORY_LABELS: Record<ManifestCategory, string> = {
  concepts: 'Core Concepts',
  'system-design-case-studies': 'System Design Case Studies',
  'oo-case-studies': 'Object-Oriented Design Case Studies',
  flashcards: 'Flashcard Decks',
};

const CATEGORY_ORDER: ManifestCategory[] = ['concepts', 'system-design-case-studies', 'oo-case-studies', 'flashcards'];

function DashboardContent(): React.JSX.Element {
  const { state, isComplete } = useProgress();

  const byCategory = new Map<ManifestCategory, ManifestEntry[]>();
  for (const entry of courseManifest) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const docEntries = courseManifest.filter((e) => e.category !== 'flashcards');
  const overallPercent = computeCompletionPercent(
    docEntries.map((e) => e.id),
    state.completed,
  );

  return (
    <main className="container margin-vert--lg">
      <h1>Your Progress</h1>
      <p>{overallPercent}% of concepts and case studies complete.</p>
      {CATEGORY_ORDER.map((category) => {
        const entries = byCategory.get(category) ?? [];
        return (
          <section key={category}>
            <h2>{CATEGORY_LABELS[category]}</h2>
            <ul>
              {entries.map((entry) => {
                if (category === 'flashcards') {
                  const deckId = entry.path.replace('/flashcards/', '');
                  const cards = FLASHCARD_DECK_CARDS[deckId] ?? [];
                  const reviewed = cards.filter((c) => state.reviewedCards[`${deckId}:${c.id}`]).length;
                  return (
                    <li key={entry.id}>
                      <Link to={entry.path}>{entry.title}</Link> — {reviewed}/{cards.length} reviewed
                    </li>
                  );
                }
                return (
                  <li key={entry.id}>
                    <Link to={entry.path}>{entry.title}</Link> {isComplete(entry.id) ? '✅' : ''}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </main>
  );
}

export default function ProgressPage(): React.JSX.Element {
  return (
    <Layout title="Progress Dashboard">
      <BrowserOnly>{() => <DashboardContent />}</BrowserOnly>
    </Layout>
  );
}
