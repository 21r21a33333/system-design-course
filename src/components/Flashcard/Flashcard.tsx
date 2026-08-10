// src/components/Flashcard/Flashcard.tsx
import React from 'react';
import styles from './styles.module.css';

export interface FlashcardData {
  id: number;
  front: string;
  back: string;
}

interface Props {
  card: FlashcardData;
  expanded: boolean;
  reviewed: boolean;
  onToggleExpanded: () => void;
  onToggleReviewed: () => void;
}

export default function Flashcard({ card, expanded, reviewed, onToggleExpanded, onToggleReviewed }: Props): React.JSX.Element {
  return (
    <div className={styles.row}>
      <div
        className={styles.rowHeader}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpanded();
          }
        }}
      >
        <span className={expanded ? styles.chevronOpen : styles.chevron} aria-hidden="true">
          ▸
        </span>
        {/* Card HTML is sanitized at ingestion time (scripts/ingest/flashcards.ts) and
            committed as static data, so rendering it directly here is safe. */}
        <div className={styles.front} dangerouslySetInnerHTML={{ __html: card.front }} />
        <label className={styles.reviewedLabel} onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={reviewed} onChange={onToggleReviewed} /> Got it
        </label>
      </div>
      {expanded && <div className={styles.answer} dangerouslySetInnerHTML={{ __html: card.back }} />}
    </div>
  );
}
