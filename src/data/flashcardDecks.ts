// src/data/flashcardDecks.ts
import systemDesign from './flashcards/system-design.json';
import systemDesignExercises from './flashcards/system-design-exercises.json';
import ooDesign from './flashcards/oo-design.json';
import type { FlashcardData } from '@site/src/components/Flashcard/Flashcard';

export const FLASHCARD_DECK_CARDS: Record<string, FlashcardData[]> = {
  'system-design': systemDesign,
  'system-design-exercises': systemDesignExercises,
  'oo-design': ooDesign,
};
