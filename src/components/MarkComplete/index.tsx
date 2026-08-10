// src/components/MarkComplete/index.tsx
import React from 'react';
import { useDoc } from '@docusaurus/plugin-content-docs/client';
import { useProgress } from '@site/src/lib/progress';
import styles from './styles.module.css';

export default function MarkComplete(): React.JSX.Element {
  const { metadata } = useDoc();
  const { isComplete, toggleComplete } = useProgress();
  const done = isComplete(metadata.id);

  return (
    <button
      type="button"
      className={done ? styles.buttonDone : styles.button}
      onClick={() => toggleComplete(metadata.id)}
    >
      {done ? '✓ Completed' : 'Mark as complete'}
    </button>
  );
}
