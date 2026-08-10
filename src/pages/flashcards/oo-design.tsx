// src/pages/flashcards/oo-design.tsx
import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import FlashcardDeck from '@site/src/components/Flashcard/FlashcardDeck';
import { FLASHCARD_DECK_CARDS } from '@site/src/data/flashcardDecks';

export default function OoDesignFlashcardsPage(): React.JSX.Element {
  return (
    <Layout title="OO Design Flashcards">
      <main className="container margin-vert--lg">
        <h1>OO Design Flashcards</h1>
        <BrowserOnly>{() => <FlashcardDeck deckId="oo-design" cards={FLASHCARD_DECK_CARDS['oo-design']} />}</BrowserOnly>
      </main>
    </Layout>
  );
}
