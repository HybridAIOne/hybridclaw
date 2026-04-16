import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'HybridClaw',
  tagline:
    'Enterprise-ready self-hosted AI assistant runtime with sandboxed execution, secure credentials, approvals, and memory',
  favicon: 'favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://www.hybridclaw.io',
  baseUrl: '/',

  organizationName: 'HybridAIOne',
  projectName: 'hybridclaw',

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs/content',
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
          editUrl:
            'https://github.com/HybridAIOne/hybridclaw/edit/main/docs/content/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'development',
        path: '../docs/development',
        routeBasePath: 'development',
        sidebarPath: './sidebars-development.ts',
        editUrl:
          'https://github.com/HybridAIOne/hybridclaw/edit/main/docs/development/',
      },
    ],
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {
            from: '/docs/getting-started/channels',
            to: '/docs/channels/overview',
          },
          { from: '/docs/imessage', to: '/docs/channels/imessage' },
          { from: '/docs/msteams', to: '/docs/channels/msteams' },
          { from: '/docs/slack', to: '/docs/channels/slack' },
          {
            from: '/docs/tools/web-search',
            to: '/docs/reference/tools/web-search',
          },
        ],
        createRedirects(existingPath) {
          // Redirect /docs/internals/* to /docs/developer-guide/*
          if (existingPath.startsWith('/docs/developer-guide')) {
            return existingPath.replace(
              '/docs/developer-guide',
              '/docs/internals',
            );
          }
          return undefined;
        },
      },
    ],
  ],

  themes: ['@easyops-cn/docusaurus-search-local'],

  themeConfig: {
    image: 'hybridclaw-logo.svg',
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'HybridClaw',
      logo: {
        alt: 'HybridClaw Logo',
        src: 'hybridclaw-logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/development/',
          label: 'Development',
          position: 'left',
          activeBaseRegex: '/development/',
        },
        {
          href: 'https://github.com/HybridAIOne/hybridclaw',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/docs/getting-started/installation' },
            { label: 'Channels', to: '/docs/channels/overview' },
            { label: 'Reference', to: '/docs/reference/commands' },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/HybridAIOne/hybridclaw',
            },
            {
              label: 'Issues',
              href: 'https://github.com/HybridAIOne/hybridclaw/issues',
            },
          ],
        },
      ],
      copyright: `Copyright \u00a9 ${new Date().getFullYear()} HybridAI One. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
