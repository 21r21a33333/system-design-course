// src/theme/DocItem/Layout/index.tsx
import React from 'react';
import Layout from '@theme-original/DocItem/Layout';
import type LayoutType from '@theme/DocItem/Layout';
import type { WrapperProps } from '@docusaurus/types';
import BrowserOnly from '@docusaurus/BrowserOnly';
import MarkComplete from '@site/src/components/MarkComplete';

type Props = WrapperProps<typeof LayoutType>;

export default function LayoutWrapper(props: Props): JSX.Element {
  return (
    <>
      <BrowserOnly>{() => <MarkComplete />}</BrowserOnly>
      <Layout {...props} />
    </>
  );
}
