// src/components/Flashcard/FlashcardDeck.tsx
import React, { useState } from 'react';
import Flashcard, { type FlashcardData } from './Flashcard';
import { useProgress } from '@site/src/lib/progress';
import styles from './styles.module.css';

interface Props {
  deckId: string;
  cards: FlashcardData[];
}

export default function FlashcardDeck({ deckId, cards }: Props): React.JSX.Element {
  const { isCardReviewed, reviewCard } = useProgress();
  // Expanded/collapsed is ephemeral UI state (not persisted) so Expand
  // all/Collapse all can control every row from one place.
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const reviewedCount = cards.filter((c) => isCardReviewed(deckId, c.id)).length;

  const toggleOne = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div>
      <div className={styles.toolbar}>
        <p className={styles.deckProgress}>
          {reviewedCount} / {cards.length} reviewed
        </p>
        <div className={styles.toolbarActions}>
          <button type="button" onClick={() => setExpandedIds(new Set(cards.map((c) => c.id)))}>
            Expand all
          </button>
          <button type="button" onClick={() => setExpandedIds(new Set())}>
            Collapse all
          </button>
        </div>
      </div>
      <div className={styles.list}>
        {cards.map((card) => (
          <Flashcard
            key={card.id}
            card={card}
            expanded={expandedIds.has(card.id)}
            reviewed={isCardReviewed(deckId, card.id)}
            onToggleExpanded={() => toggleOne(card.id)}
            onToggleReviewed={() => reviewCard(deckId, card.id, !isCardReviewed(deckId, card.id))}
          />
        ))}
      </div>
    </div>
  );
}
