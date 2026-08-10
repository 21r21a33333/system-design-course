// src/theme/DocItem/Layout/index.tsx
import React from 'react';
import Layout from '@theme-original/DocItem/Layout';
import type LayoutType from '@theme/DocItem/Layout';
import type { WrapperProps } from '@docusaurus/types';
import BrowserOnly from '@docusaurus/BrowserOnly';
import { useDoc } from '@docusaurus/plugin-content-docs/client';
import MarkComplete from '@site/src/components/MarkComplete';
import SupplementaryBadge from '@site/src/components/SupplementaryBadge';

type Props = WrapperProps<typeof LayoutType>;

export default function LayoutWrapper(props: Props): React.JSX.Element {
  const { metadata } = useDoc();
  const isSupplementary = metadata.frontMatter.supplementary === true;

  return (
    <>
      <BrowserOnly>
        {() => (
          <>
            {isSupplementary && <SupplementaryBadge />}
            <MarkComplete />
          </>
        )}
      </BrowserOnly>
      <Layout {...props} />
    </>
  );
}
