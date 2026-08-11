import {themes as prismThemes} from 'prism-react-renderer';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'System Design Course',
  tagline: 'A self-hosted, progress-tracked walkthrough of donnemartin/system-design-primer',
  favicon: 'img/favicon.ico',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://21r21a33333.github.io',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/system-design-course/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: '21r21a33333', // Usually your GitHub org/user name.
  projectName: 'system-design-course', // Usually your repo name.

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  // Render ```mermaid fenced blocks as diagrams (recurrence trees, decision
  // trees, structure diagrams throughout the DSA course).
  markdown: {
    mermaid: true,
  },

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'course',
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          // KaTeX math rendering for the DSA course (recurrences, complexity,
          // number-theory formulas). CSS is bundled locally via src/css/custom.css
          // to keep the site self-hosted with no CDN dependency.
          remarkPlugins: [remarkMath],
          rehypePlugins: [rehypeKatex],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  // Builds a static search index at build time — no external service, no
  // API keys, consistent with the rest of the site being self-hosted with
  // zero backend.
  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: '/docs',
      },
    ],
  ],

  themeConfig: {
    // Replace with your project's social card
    image: 'img/docusaurus-social-card.jpg',
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'System Design Course',
      items: [
        { type: 'docSidebar', sidebarId: 'courseSidebar', position: 'left', label: 'Course' },
        { to: '/flashcards/system-design', label: 'Flashcards', position: 'left' },
        { to: '/progress', label: 'My Progress', position: 'left' },
      ],
    },
    footer: {
      style: 'dark',
      links: [],
      copyright: `Content adapted from <a href="https://github.com/donnemartin/system-design-primer">donnemartin/system-design-primer</a>, licensed <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      // C++ is the core-code language for the DSA course; not in Prism's default set.
      additionalLanguages: ['cpp'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
