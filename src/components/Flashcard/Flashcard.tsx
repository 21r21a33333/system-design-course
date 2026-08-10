// src/components/Flashcard/Flashcard.tsx
import React, { useState } from 'react';
import styles from './styles.module.css';

export interface FlashcardData {
  id: number;
  front: string;
  back: string;
}

interface Props {
  card: FlashcardData;
  reviewed: boolean;
  onToggleReviewed: () => void;
}

export default function Flashcard({ card, reviewed, onToggleReviewed }: Props): React.JSX.Element {
  const [flipped, setFlipped] = useState(false);

  return (
    <div className={styles.card}>
      {/* Card HTML is sanitized at ingestion time (scripts/ingest/flashcards.ts) and
          committed as static data, so rendering it directly here is safe. */}
      <div
        className={styles.face}
        role="button"
        tabIndex={0}
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setFlipped((f) => !f);
        }}
        dangerouslySetInnerHTML={{ __html: flipped ? card.back : card.front }}
      />
      <div className={styles.controls}>
        <button type="button" onClick={() => setFlipped((f) => !f)}>
          {flipped ? 'Show front' : 'Show back'}
        </button>
        <label className={styles.reviewedLabel}>
          <input type="checkbox" checked={reviewed} onChange={onToggleReviewed} /> Got it
        </label>
      </div>
    </div>
  );
}
