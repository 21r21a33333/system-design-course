// src/pages/flashcards/system-design-exercises.tsx
import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import FlashcardDeck from '@site/src/components/Flashcard/FlashcardDeck';
import { FLASHCARD_DECK_CARDS } from '@site/src/data/flashcardDecks';

export default function SystemDesignExercisesFlashcardsPage(): React.JSX.Element {
  return (
    <Layout title="System Design Exercises Flashcards">
      <main className="container margin-vert--lg">
        <h1>System Design Exercises Flashcards</h1>
        <BrowserOnly>
          {() => <FlashcardDeck deckId="system-design-exercises" cards={FLASHCARD_DECK_CARDS['system-design-exercises']} />}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
