import React, { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'sdp-progress-v1';

export interface ProgressState {
  completed: Record<string, boolean>;
  reviewedCards: Record<string, boolean>; // key: `${deckId}:${cardId}`
}

const EMPTY_STATE: ProgressState = { completed: {}, reviewedCards: {} };

function loadState(): ProgressState {
  if (typeof window === 'undefined') return EMPTY_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...EMPTY_STATE, ...JSON.parse(raw) } : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

function saveState(state: ProgressState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

interface ProgressContextValue {
  state: ProgressState;
  isComplete: (id: string) => boolean;
  toggleComplete: (id: string) => void;
  isCardReviewed: (deckId: string, cardId: number) => boolean;
  reviewCard: (deckId: string, cardId: number, reviewed: boolean) => void;
}

const ProgressContext = createContext<ProgressContextValue | null>(null);

export function ProgressProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<ProgressState>(EMPTY_STATE);

  useEffect(() => {
    setState(loadState());
  }, []);

  const update = useCallback((updater: (prev: ProgressState) => ProgressState) => {
    setState((prev) => {
      const next = updater(prev);
      saveState(next);
      return next;
    });
  }, []);

  const toggleComplete = useCallback(
    (id: string) => update((prev) => ({ ...prev, completed: { ...prev.completed, [id]: !prev.completed[id] } })),
    [update],
  );

  const reviewCard = useCallback(
    (deckId: string, cardId: number, reviewed: boolean) =>
      update((prev) => ({ ...prev, reviewedCards: { ...prev.reviewedCards, [`${deckId}:${cardId}`]: reviewed } })),
    [update],
  );

  const value: ProgressContextValue = {
    state,
    isComplete: (id) => Boolean(state.completed[id]),
    toggleComplete,
    isCardReviewed: (deckId, cardId) => Boolean(state.reviewedCards[`${deckId}:${cardId}`]),
    reviewCard,
  };

  return <ProgressContext.Provider value={value}>{children}</ProgressContext.Provider>;
}

export function useProgress(): ProgressContextValue {
  const ctx = useContext(ProgressContext);
  if (!ctx) throw new Error('useProgress must be used within ProgressProvider');
  return ctx;
}

export function computeCompletionPercent(ids: string[], completed: Record<string, boolean>): number {
  if (ids.length === 0) return 0;
  const done = ids.filter((id) => completed[id]).length;
  return Math.round((done / ids.length) * 100);
}
