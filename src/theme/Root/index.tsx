import React from 'react';
import type { Props } from '@theme/Root';
import { ProgressProvider } from '@site/src/lib/progress';

export default function Root({ children }: Props): React.JSX.Element {
  return <ProgressProvider>{children}</ProgressProvider>;
}
