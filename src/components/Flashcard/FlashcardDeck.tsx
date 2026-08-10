// src/components/Flashcard/FlashcardDeck.tsx
import React from 'react';
import Flashcard, { type FlashcardData } from './Flashcard';
import { useProgress } from '@site/src/lib/progress';
import styles from './styles.module.css';

interface Props {
  deckId: string;
  cards: FlashcardData[];
}

export default function FlashcardDeck({ deckId, cards }: Props): React.JSX.Element {
  const { isCardReviewed, reviewCard } = useProgress();
  const reviewedCount = cards.filter((c) => isCardReviewed(deckId, c.id)).length;

  return (
    <div>
      <p className={styles.deckProgress}>
        {reviewedCount} / {cards.length} reviewed
      </p>
      <div className={styles.grid}>
        {cards.map((card) => (
          <Flashcard
            key={card.id}
            card={card}
            reviewed={isCardReviewed(deckId, card.id)}
            onToggleReviewed={() => reviewCard(deckId, card.id, !isCardReviewed(deckId, card.id))}
          />
        ))}
      </div>
    </div>
  );
}
