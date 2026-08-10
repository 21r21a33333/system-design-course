// src/components/SupplementaryBadge/index.tsx
import React from 'react';
import styles from './styles.module.css';

export default function SupplementaryBadge(): React.JSX.Element {
  return <span className={styles.badge}>Supplementary — not from the original primer</span>;
}
