// src/pages/flashcards/system-design.tsx
import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import FlashcardDeck from '@site/src/components/Flashcard/FlashcardDeck';
import { FLASHCARD_DECK_CARDS } from '@site/src/data/flashcardDecks';

export default function SystemDesignFlashcardsPage(): React.JSX.Element {
  return (
    <Layout title="System Design Flashcards">
      <main className="container margin-vert--lg">
        <h1>System Design Flashcards</h1>
        <BrowserOnly>{() => <FlashcardDeck deckId="system-design" cards={FLASHCARD_DECK_CARDS['system-design']} />}</BrowserOnly>
      </main>
    </Layout>
  );
}
