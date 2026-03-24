import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { parse as parseYaml } from 'yaml';
import { resolveInstallPath } from '../infra/install-root.js';

const SITE_DIR = resolveInstallPath('docs');
const DEVELOPMENT_DOCS_DIR = resolveInstallPath('docs', 'development');
const GITHUB_REPO_URL = 'https://github.com/HybridAIOne/hybridclaw';
const DISCORD_URL = 'https://discord.gg/jsVW4vJw27';
const SEARCH_RESULT_LIMIT = 10;
const DEVELOPMENT_DOCS_CACHE_TTL_MS = 1_000;

export const DEVELOPMENT_DOCS_ROUTE = '/development';

const DEVELOPMENT_DOCS_HTML_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'details',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'li',
    'ol',
    'p',
    'pre',
    'strong',
    'summary',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  allowedAttributes: {
    a: ['aria-hidden', 'class', 'href', 'rel', 'target', 'title'],
    code: ['class'],
    h1: ['id'],
    h2: ['id'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
    img: ['src', 'alt', 'title'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowedSchemesByTag: {
    img: ['https'],
  },
  allowProtocolRelative: false,
};

type DevelopmentDocMetadata = {
  description?: unknown;
  sidebar_position?: unknown;
  title?: unknown;
};

type DevelopmentDocCategoryMetadata = {
  collapsed?: unknown;
  label?: unknown;
  position?: unknown;
};

type DevelopmentDocHeading = {
  depth: number;
  id: string;
  text: string;
};

type DevelopmentDocPage = {
  body: string;
  description: string;
  headings: DevelopmentDocHeading[];
  relativePath: string;
  routePath: string;
  sidebarPosition: number | null;
  source: string;
  title: string;
};

type DevelopmentDocSearchEntry = {
  description: string;
  kind: 'doc' | 'heading';
  label: string;
  parentTitle: string;
  routePath: string;
};

type SidebarNode = {
  children: SidebarNode[];
  description: string;
  isPage: boolean;
  label: string;
  pathKey: string;
  position: number | null;
  routePath: string | null;
};

type CategoryMetadataReader = (
  relativeDirPath: string,
) => DevelopmentDocCategoryMetadata | null;

type DevelopmentDocsSnapshot = {
  cachedAt: number;
  docs: DevelopmentDocPage[];
  docsByRelativePath: Map<string, DevelopmentDocPage>;
  readCategoryMetadataCached: CategoryMetadataReader;
  searchEntries: DevelopmentDocSearchEntry[];
  sidebarTree: SidebarNode;
};

let developmentDocsSnapshotCache: DevelopmentDocsSnapshot | null = null;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function humanizeSegment(segment: string): string {
  return segment
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseDevelopmentDoc(
  raw: string,
  relativePath: string,
): {
  body: string;
  metadata: DevelopmentDocMetadata;
} {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { body: normalized, metadata: {} };
  }
  let metadata: DevelopmentDocMetadata = {};
  try {
    metadata = (parseYaml(match[1]) as DevelopmentDocMetadata | null) || {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frontmatter in ${relativePath}: ${message}`);
  }
  return {
    body: normalized.slice(match[0].length),
    metadata,
  };
}

function readCategoryMetadata(
  relativeDirPath: string,
): DevelopmentDocCategoryMetadata | null {
  const categoryPath = path.resolve(
    DEVELOPMENT_DOCS_DIR,
    relativeDirPath,
    '_category_.json',
  );
  const resolvedCategoryPath = resolveContainedFilePath(
    DEVELOPMENT_DOCS_DIR,
    categoryPath,
  );
  if (!resolvedCategoryPath) return null;
  try {
    return JSON.parse(
      fs.readFileSync(resolvedCategoryPath, 'utf8'),
    ) as DevelopmentDocCategoryMetadata;
  } catch {
    return null;
  }
}

function resolveContainedFilePath(
  rootDir: string,
  candidatePath: string,
): string | null {
  if (!candidatePath.startsWith(rootDir)) return null;

  let candidateStats: fs.Stats;
  try {
    candidateStats = fs.lstatSync(candidatePath);
  } catch {
    return null;
  }
  if (!candidateStats.isFile()) return null;

  try {
    const realRootDir = fs.realpathSync.native(rootDir);
    const realCandidatePath = fs.realpathSync.native(candidatePath);
    if (
      realCandidatePath !== realRootDir &&
      !realCandidatePath.startsWith(`${realRootDir}${path.sep}`)
    ) {
      return null;
    }
    return realCandidatePath;
  } catch {
    return null;
  }
}

function createCategoryMetadataReader(): CategoryMetadataReader {
  const cache = new Map<string, DevelopmentDocCategoryMetadata | null>();
  return (relativeDirPath) => {
    if (cache.has(relativeDirPath)) {
      return cache.get(relativeDirPath) ?? null;
    }
    const metadata = readCategoryMetadata(relativeDirPath);
    cache.set(relativeDirPath, metadata);
    return metadata;
  };
}

function resolveDevelopmentDocFile(relativePath: string): string | null {
  const candidate = path.resolve(DEVELOPMENT_DOCS_DIR, relativePath);
  return resolveContainedFilePath(DEVELOPMENT_DOCS_DIR, candidate);
}

function normalizeDevelopmentDocRelativePath(pathname: string): string | null {
  if (
    pathname === DEVELOPMENT_DOCS_ROUTE ||
    pathname === `${DEVELOPMENT_DOCS_ROUTE}/`
  ) {
    return 'README.md';
  }
  if (!pathname.startsWith(`${DEVELOPMENT_DOCS_ROUTE}/`)) return null;
  const rawRelativePath = pathname.slice(DEVELOPMENT_DOCS_ROUTE.length + 1);
  if (!rawRelativePath) return 'README.md';

  const normalized = path.posix
    .normalize(rawRelativePath.replaceAll('\\', '/'))
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    return null;
  }

  const extension = path.posix.extname(normalized);
  if (extension && extension !== '.md') return null;

  const withoutExtension =
    extension === '.md' ? normalized.slice(0, -3) : normalized;
  if (!withoutExtension || withoutExtension === 'README') return 'README.md';

  const candidates =
    extension === '.md'
      ? [normalized]
      : path.posix.basename(withoutExtension).toUpperCase() === 'README'
        ? [`${withoutExtension}.md`]
        : [`${withoutExtension}.md`, `${withoutExtension}/README.md`];

  for (const candidate of candidates) {
    if (resolveDevelopmentDocFile(candidate)) return candidate;
  }

  return candidates[0] || null;
}

function routePathForDevelopmentDoc(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath);
  const trimmed = normalized
    .replace(/\/?README\.md$/i, '')
    .replace(/\.md$/i, '');
  if (!trimmed || trimmed === '.') return DEVELOPMENT_DOCS_ROUTE;
  return `${DEVELOPMENT_DOCS_ROUTE}/${trimmed}`;
}

function markdownPathForDevelopmentDoc(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath).replace(/^\/+/, '');
  return `${DEVELOPMENT_DOCS_ROUTE}/${normalized}`;
}

function stripMarkdownFormatting(value: string): string {
  return value
    .replace(/\s+\{#.+\}\s*$/, '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function slugifyHeadingText(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'section';
}

function extractHeadingsFromMarkdown(body: string): DevelopmentDocHeading[] {
  const headings: DevelopmentDocHeading[] = [];
  const slugCounts = new Map<string, number>();
  let inCodeFence = false;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;

    const depth = match[1].length;
    const text = stripMarkdownFormatting(match[2]);
    if (!text) continue;

    const baseSlug = slugifyHeadingText(text);
    const seen = slugCounts.get(baseSlug) || 0;
    slugCounts.set(baseSlug, seen + 1);
    const id = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;

    headings.push({ depth, id, text });
  }

  return headings;
}

function inferDevelopmentDocTitle(body: string, relativePath: string): string {
  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]) return stripMarkdownFormatting(headingMatch[1]);
  const basename = path.posix.basename(relativePath, '.md');
  if (!basename || basename.toUpperCase() === 'README') {
    return 'Development Docs';
  }
  return humanizeSegment(basename);
}

function readDevelopmentDoc(relativePath: string): DevelopmentDocPage | null {
  const candidate = resolveDevelopmentDocFile(relativePath);
  if (!candidate) return null;

  const raw = fs.readFileSync(candidate, 'utf8');
  const { body, metadata } = parseDevelopmentDoc(raw, relativePath);

  return {
    body,
    description:
      typeof metadata.description === 'string'
        ? metadata.description.trim()
        : '',
    headings: extractHeadingsFromMarkdown(body),
    relativePath,
    routePath: routePathForDevelopmentDoc(relativePath),
    sidebarPosition:
      typeof metadata.sidebar_position === 'number'
        ? metadata.sidebar_position
        : null,
    source: raw,
    title:
      typeof metadata.title === 'string' && metadata.title.trim()
        ? metadata.title.trim()
        : inferDevelopmentDocTitle(body, relativePath),
  };
}

function collectDevelopmentDocPaths(
  rootDir: string,
  currentDir = rootDir,
): string[] {
  if (!fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory()) {
    return [];
  }

  const paths: string[] = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...collectDevelopmentDocPaths(rootDir, absolutePath));
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name) !== '.md') continue;
    paths.push(path.relative(rootDir, absolutePath).replaceAll(path.sep, '/'));
  }
  return paths;
}

function sortDevelopmentDocs(
  left: DevelopmentDocPage,
  right: DevelopmentDocPage,
): number {
  const leftPosition = left.sidebarPosition ?? Number.POSITIVE_INFINITY;
  const rightPosition = right.sidebarPosition ?? Number.POSITIVE_INFINITY;
  if (leftPosition !== rightPosition) return leftPosition - rightPosition;
  return left.title.localeCompare(right.title);
}

function getCachedDevelopmentDocsSnapshot(): DevelopmentDocsSnapshot | null {
  if (!developmentDocsSnapshotCache) return null;
  if (
    Date.now() - developmentDocsSnapshotCache.cachedAt >
    DEVELOPMENT_DOCS_CACHE_TTL_MS
  ) {
    developmentDocsSnapshotCache = null;
    return null;
  }
  return developmentDocsSnapshotCache;
}

function buildDevelopmentDocsSnapshot(
  preloadedPage?: DevelopmentDocPage,
): DevelopmentDocsSnapshot {
  const docs = collectDevelopmentDocPaths(DEVELOPMENT_DOCS_DIR)
    .map((relativePath) =>
      preloadedPage?.relativePath === relativePath
        ? preloadedPage
        : readDevelopmentDoc(relativePath),
    )
    .filter((entry): entry is DevelopmentDocPage => entry !== null)
    .sort(sortDevelopmentDocs);
  const docsByRelativePath = new Map(
    docs.map((entry) => [entry.relativePath, entry] as const),
  );
  const readCategoryMetadataCached = createCategoryMetadataReader();
  const snapshot: DevelopmentDocsSnapshot = {
    cachedAt: Date.now(),
    docs,
    docsByRelativePath,
    readCategoryMetadataCached,
    searchEntries: buildSearchIndex(docs),
    sidebarTree: buildSidebarTree(docs, readCategoryMetadataCached),
  };
  developmentDocsSnapshotCache = snapshot;
  return snapshot;
}

function getDevelopmentDocsSnapshot(
  preloadedPage?: DevelopmentDocPage,
): DevelopmentDocsSnapshot {
  const cachedSnapshot = getCachedDevelopmentDocsSnapshot();
  return cachedSnapshot || buildDevelopmentDocsSnapshot(preloadedPage);
}

function buildUrlSuffix(
  queryString: string | undefined,
  hashFragment: string | undefined,
): string {
  return [
    queryString ? `?${queryString}` : '',
    hashFragment ? `#${hashFragment}` : '',
  ].join('');
}

function isAllowedDevelopmentImageSrc(src: string): boolean {
  return src.startsWith('/') || src.startsWith('https://');
}

function rewriteRelativeHref(
  href: string,
  currentRelativePath: string,
): string {
  if (
    !href ||
    href.startsWith('#') ||
    href.startsWith('/') ||
    /^[a-z][a-z\d+\-.]*:/i.test(href)
  ) {
    return href;
  }

  const [hrefWithoutHash, hashFragment] = href.split('#', 2);
  const [hrefPath, queryString] = hrefWithoutHash.split('?', 2);
  if (!hrefPath) return href;

  const currentAbsolutePath = path.resolve(
    DEVELOPMENT_DOCS_DIR,
    currentRelativePath,
  );
  const resolvedAbsolutePath = path.resolve(
    path.dirname(currentAbsolutePath),
    hrefPath,
  );

  if (
    resolvedAbsolutePath === DEVELOPMENT_DOCS_DIR ||
    resolvedAbsolutePath.startsWith(`${DEVELOPMENT_DOCS_DIR}${path.sep}`)
  ) {
    const extension = path.extname(resolvedAbsolutePath);
    if (
      extension &&
      extension !== '.md' &&
      fs.existsSync(resolvedAbsolutePath) &&
      fs.statSync(resolvedAbsolutePath).isFile()
    ) {
      const relativeToSite = path
        .relative(SITE_DIR, resolvedAbsolutePath)
        .replaceAll(path.sep, '/');
      return `/${relativeToSite}${buildUrlSuffix(queryString, hashFragment)}`;
    }
    const relativePath = path
      .relative(DEVELOPMENT_DOCS_DIR, resolvedAbsolutePath)
      .replaceAll(path.sep, '/');
    const routePath = routePathForDevelopmentDoc(relativePath);
    return `${routePath}${buildUrlSuffix(queryString, hashFragment)}`;
  }

  if (
    resolvedAbsolutePath === SITE_DIR ||
    resolvedAbsolutePath.startsWith(`${SITE_DIR}${path.sep}`)
  ) {
    if (
      fs.existsSync(resolvedAbsolutePath) &&
      fs.statSync(resolvedAbsolutePath).isFile()
    ) {
      const relativePath = path
        .relative(SITE_DIR, resolvedAbsolutePath)
        .replaceAll(path.sep, '/');
      return `/${relativePath}${buildUrlSuffix(queryString, hashFragment)}`;
    }
  }
  return href;
}

function buildSidebarTree(
  docs: DevelopmentDocPage[],
  readCategoryMetadataCached: CategoryMetadataReader,
): SidebarNode {
  const rootMeta = readCategoryMetadataCached('') || {};
  const root: SidebarNode = {
    children: [],
    description: '',
    isPage: false,
    label:
      typeof rootMeta.label === 'string' && rootMeta.label.trim()
        ? rootMeta.label.trim()
        : 'Development',
    pathKey: '',
    position: typeof rootMeta.position === 'number' ? rootMeta.position : 1,
    routePath: null,
  };

  for (const page of docs) {
    if (page.relativePath === 'README.md') continue;

    const parts = page.relativePath.split('/');
    let cursor = root;
    let currentPath = '';

    for (const segment of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let group = cursor.children.find(
        (entry) => !entry.isPage && entry.pathKey === currentPath,
      );
      if (!group) {
        const categoryMeta = readCategoryMetadataCached(currentPath) || {};
        group = {
          children: [],
          description: '',
          isPage: false,
          label:
            typeof categoryMeta.label === 'string' && categoryMeta.label.trim()
              ? categoryMeta.label.trim()
              : humanizeSegment(segment),
          pathKey: currentPath,
          position:
            typeof categoryMeta.position === 'number'
              ? categoryMeta.position
              : null,
          routePath: null,
        };
        cursor.children.push(group);
      }
      cursor = group;
    }

    cursor.children.push({
      children: [],
      description: page.description,
      isPage: true,
      label: page.title,
      pathKey: page.relativePath,
      position: page.sidebarPosition,
      routePath: page.routePath,
    });
  }

  const sortTree = (node: SidebarNode) => {
    node.children.sort((left, right) => {
      const leftPosition = left.position ?? Number.POSITIVE_INFINITY;
      const rightPosition = right.position ?? Number.POSITIVE_INFINITY;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      if (left.isPage !== right.isPage) return left.isPage ? 1 : -1;
      return left.label.localeCompare(right.label);
    });
    for (const child of node.children) sortTree(child);
  };
  sortTree(root);
  return root;
}

function sidebarNodeContainsRoute(
  node: SidebarNode,
  currentRoutePath: string,
): boolean {
  if (node.isPage) return node.routePath === currentRoutePath;
  return node.children.some((child) =>
    sidebarNodeContainsRoute(child, currentRoutePath),
  );
}

function renderSidebarNode(
  node: SidebarNode,
  currentRoutePath: string,
): string {
  if (node.isPage) {
    const isActive = node.routePath === currentRoutePath;
    return `<a class="docs-sidebar-link${isActive ? ' is-active' : ''}" href="${escapeHtml(node.routePath || DEVELOPMENT_DOCS_ROUTE)}"${isActive ? ' aria-current="page"' : ''}><span>${escapeHtml(node.label)}</span></a>`;
  }

  const hasActiveDescendant = sidebarNodeContainsRoute(node, currentRoutePath);
  const childrenMarkup = node.children
    .map((child) => renderSidebarNode(child, currentRoutePath))
    .join('');

  if (!node.pathKey) {
    return `<div class="docs-sidebar-root"><div class="docs-sidebar-section-title">${escapeHtml(node.label)}</div><div class="docs-sidebar-section-items">${childrenMarkup}</div></div>`;
  }

  return `<details class="docs-sidebar-group" ${
    hasActiveDescendant ? 'open' : ''
  }><summary>${escapeHtml(node.label)}</summary><div class="docs-sidebar-group-items">${childrenMarkup}</div></details>`;
}

function buildSearchIndex(
  docs: DevelopmentDocPage[],
): DevelopmentDocSearchEntry[] {
  return docs.flatMap((page) => {
    const entries: DevelopmentDocSearchEntry[] = [
      {
        description: page.description,
        kind: 'doc',
        label: page.title,
        parentTitle: page.title,
        routePath: page.routePath,
      },
    ];

    for (const heading of page.headings) {
      if (heading.depth < 2) continue;
      entries.push({
        description: page.description,
        kind: 'heading',
        label: heading.text,
        parentTitle: page.title,
        routePath: `${page.routePath}#${heading.id}`,
      });
    }

    return entries;
  });
}

function buildBreadcrumbs(
  page: DevelopmentDocPage,
  docsByRelativePath: Map<string, DevelopmentDocPage>,
  rootLabel: string,
  readCategoryMetadataCached: CategoryMetadataReader,
): Array<{ href: string | null; label: string }> {
  const items: Array<{ href: string | null; label: string }> = [
    { href: '/', label: 'Home' },
    { href: DEVELOPMENT_DOCS_ROUTE, label: rootLabel },
  ];

  const parts = page.relativePath.split('/');
  let currentPath = '';
  for (const segment of parts.slice(0, -1)) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const categoryMeta = readCategoryMetadataCached(currentPath) || {};
    const label =
      typeof categoryMeta.label === 'string' && categoryMeta.label.trim()
        ? categoryMeta.label.trim()
        : humanizeSegment(segment);
    const indexDoc = docsByRelativePath.get(`${currentPath}/README.md`);
    items.push({
      href: indexDoc?.routePath || null,
      label,
    });
  }

  items.push({ href: null, label: page.title });
  return items;
}

function renderBreadcrumbs(
  page: DevelopmentDocPage,
  docsByRelativePath: Map<string, DevelopmentDocPage>,
  rootLabel: string,
  readCategoryMetadataCached: CategoryMetadataReader,
): string {
  return buildBreadcrumbs(
    page,
    docsByRelativePath,
    rootLabel,
    readCategoryMetadataCached,
  )
    .map((item, index, items) => {
      const renderedLabel = escapeHtml(item.label);
      const body = item.href
        ? `<a href="${escapeHtml(item.href)}">${renderedLabel}</a>`
        : `<span aria-current="page">${renderedLabel}</span>`;
      const suffix =
        index === items.length - 1
          ? ''
          : '<span class="docs-breadcrumb-separator">/</span>';
      return `<span class="docs-breadcrumb-item">${body}${suffix}</span>`;
    })
    .join('');
}

function renderExternalLinkIcon(): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 2h4v4h-1.5V4.56L7.03 10.03l-1.06-1.06L11.44 3.5H10V2ZM3 4h4v1.5H4.5v6h6V9H12v4H3V4Z" fill="currentColor"></path></svg>`;
}

function renderSearchDataScript(entries: DevelopmentDocSearchEntry[]): string {
  const json = JSON.stringify(entries).replace(/</g, '\\u003c');
  return `<script id="docs-search-data" type="application/json">${json}</script>`;
}

function renderMarkdownSourceScript(source: string): string {
  const json = JSON.stringify(source).replace(/</g, '\\u003c');
  return `<script id="docs-markdown-source" type="application/json">${json}</script>`;
}

function renderInteractiveScript(): string {
  return `<script>
(() => {
  const body = document.body;
  const copyMarkdownButton = document.querySelector('[data-doc-copy-markdown]');
  const searchInput = document.querySelector('[data-doc-search-input]');
  const searchResults = document.querySelector('[data-doc-search-results]');
  const markdownSource = JSON.parse(document.getElementById('docs-markdown-source')?.textContent || '""');
  const searchData = JSON.parse(document.getElementById('docs-search-data')?.textContent || '[]');
  const searchEmpty = document.querySelector('[data-doc-search-empty]');
  const searchList = document.querySelector('[data-doc-search-list]');
  const sidebarToggle = document.querySelector('[data-doc-sidebar-toggle]');
  const overlay = document.querySelector('[data-doc-overlay]');
  const themeToggle = document.querySelector('[data-doc-theme-toggle]');
  const tocLinks = Array.from(document.querySelectorAll('[data-doc-toc-link]'));
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  const isEditableTarget = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT');

  const copyWithFallback = (text) => {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'absolute';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    document.body.removeChild(helper);
  };

  const copyText = async (text) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    copyWithFallback(text);
  };

  const closeSidebar = () => body.classList.remove('docs-sidebar-open');
  sidebarToggle?.addEventListener('click', () => {
    body.classList.toggle('docs-sidebar-open');
  });
  overlay?.addEventListener('click', closeSidebar);

  copyMarkdownButton?.addEventListener('click', async () => {
    if (!markdownSource) return;
    const previousText = copyMarkdownButton.textContent || 'Copy Markdown';
    try {
      await copyText(markdownSource);
      copyMarkdownButton.textContent = 'Copied';
      copyMarkdownButton.classList.add('is-copied');
      window.setTimeout(() => {
        copyMarkdownButton.textContent = previousText;
        copyMarkdownButton.classList.remove('is-copied');
      }, 1400);
    } catch {
      copyMarkdownButton.textContent = 'Copy failed';
      window.setTimeout(() => {
        copyMarkdownButton.textContent = previousText;
      }, 1400);
    }
  });

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('hybridclaw-docs-theme', theme);
    } catch {}
    if (themeToggle) {
      themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
    }
  };

  let initialTheme = 'light';
  try {
    const storedTheme = localStorage.getItem('hybridclaw-docs-theme');
    if (storedTheme === 'light' || storedTheme === 'dark') {
      initialTheme = storedTheme;
    } else if (mediaQuery.matches) {
      initialTheme = 'dark';
    }
  } catch {
    if (mediaQuery.matches) initialTheme = 'dark';
  }
  applyTheme(initialTheme);

  themeToggle?.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  const renderSearchResults = (query) => {
    if (!searchList || !searchResults || !searchEmpty) return [];
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      searchResults.hidden = true;
      searchList.innerHTML = '';
      searchEmpty.hidden = true;
      return [];
    }
    const ranked = searchData
      .map((entry) => {
        const haystack = [entry.label, entry.parentTitle, entry.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(normalizedQuery)) return null;
        const score = entry.label.toLowerCase().startsWith(normalizedQuery)
          ? 0
          : entry.parentTitle.toLowerCase().startsWith(normalizedQuery)
            ? 1
            : 2;
        return { entry, score };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.score !== right.score) return left.score - right.score;
        return left.entry.label.localeCompare(right.entry.label);
      })
      .slice(0, ${SEARCH_RESULT_LIMIT});

    searchList.innerHTML = '';
    searchResults.hidden = false;
    searchEmpty.hidden = ranked.length !== 0;

    for (const { entry } of ranked) {
      const link = document.createElement('a');
      link.className = 'docs-search-result';
      link.href = entry.routePath;

      const title = document.createElement('strong');
      title.textContent = entry.label;
      link.appendChild(title);

      const meta = document.createElement('span');
      meta.className = 'docs-search-result-meta';
      meta.textContent =
        entry.kind === 'heading'
          ? entry.parentTitle
          : entry.description || entry.parentTitle;
      link.appendChild(meta);

      searchList.appendChild(link);
    }

    return ranked.map((item) => item.entry);
  };

  searchInput?.addEventListener('input', () => {
    renderSearchResults(searchInput.value || '');
  });

  searchInput?.addEventListener('focus', () => {
    renderSearchResults(searchInput.value || '');
  });

  searchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      renderSearchResults('');
      searchInput.blur();
      return;
    }
    if (event.key === 'Enter') {
      const matches = renderSearchResults(searchInput.value || '');
      if (matches[0]?.routePath) {
        window.location.href = matches[0].routePath;
      }
    }
  });

  document.addEventListener('click', (event) => {
    if (
      searchResults &&
      !searchResults.contains(event.target) &&
      event.target !== searchInput
    ) {
      searchResults.hidden = true;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (
      (event.key === '/' && !isEditableTarget(event.target)) ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')
    ) {
      event.preventDefault();
      searchInput?.focus();
      searchInput?.select();
      return;
    }
    if (event.key === 'Escape') {
      closeSidebar();
    }
  });

  if (tocLinks.length) {
    const sections = tocLinks
      .map((link) => {
        const href = link.getAttribute('href') || '';
        const target = href.startsWith('#')
          ? document.getElementById(href.slice(1))
          : null;
        return target ? { link, target } : null;
      })
      .filter(Boolean);

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        if (!visible[0]) return;
        const activeId = visible[0].target.id;
        for (const item of sections) {
          item.link.classList.toggle(
            'is-active',
            item.link.getAttribute('href') === '#' + activeId,
          );
        }
      },
      {
        rootMargin: '-96px 0px -55% 0px',
        threshold: [0, 1],
      },
    );

    for (const section of sections) {
      observer.observe(section.target);
    }
  }
})();
</script>`;
}

function renderMarkdownBody(page: DevelopmentDocPage): string {
  const plannedHeadings = page.headings.filter((heading) => heading.depth <= 4);
  let headingIndex = 0;
  const renderer = new marked.Renderer();

  renderer.heading = function ({ depth, tokens }) {
    const fallbackText = stripMarkdownFormatting(
      this.parser.parseInline(tokens),
    );
    const heading =
      depth <= 4
        ? plannedHeadings[headingIndex++] || {
            depth,
            id: slugifyHeadingText(fallbackText),
            text: fallbackText,
          }
        : {
            depth,
            id: slugifyHeadingText(fallbackText),
            text: fallbackText,
          };
    const content = this.parser.parseInline(tokens);
    const anchor = `<a class="docs-heading-anchor" href="#${escapeHtml(
      heading.id,
    )}" aria-hidden="true">#</a>`;
    return `<h${depth} id="${escapeHtml(heading.id)}">${content}${anchor}</h${depth}>`;
  };

  renderer.link = function ({ href, title, tokens }) {
    const resolvedHref = rewriteRelativeHref(href || '', page.relativePath);
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const externalAttrs = /^https?:\/\//i.test(resolvedHref)
      ? ' target="_blank" rel="noreferrer"'
      : '';
    return `<a href="${escapeHtml(
      resolvedHref,
    )}"${titleAttr}${externalAttrs}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const resolvedHref = rewriteRelativeHref(href || '', page.relativePath);
    if (!isAllowedDevelopmentImageSrc(resolvedHref)) {
      return `<span>${escapeHtml(text || '')}</span>`;
    }
    const alt = escapeHtml(text || '');
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(resolvedHref)}" alt="${alt}"${titleAttr}>`;
  };

  const rendered = marked.parse(page.body, {
    async: false,
    gfm: true,
    renderer,
  });
  return sanitizeHtml(rendered, DEVELOPMENT_DOCS_HTML_SANITIZE_OPTIONS);
}

function renderTableOfContents(page: DevelopmentDocPage): string {
  const headings = page.headings.filter(
    (heading) => heading.depth >= 2 && heading.depth <= 4,
  );
  if (headings.length === 0) {
    return '<div class="docs-toc-empty">This page has no sectional headings.</div>';
  }
  return headings
    .map(
      (heading) =>
        `<a class="docs-toc-link depth-${heading.depth}" data-doc-toc-link href="#${escapeHtml(
          heading.id,
        )}">${escapeHtml(heading.text)}</a>`,
    )
    .join('');
}

function renderPage(
  page: DevelopmentDocPage,
  snapshot: DevelopmentDocsSnapshot,
): string {
  const sidebarMarkup = renderSidebarNode(snapshot.sidebarTree, page.routePath);
  const breadcrumbsMarkup = renderBreadcrumbs(
    page,
    snapshot.docsByRelativePath,
    snapshot.sidebarTree.label,
    snapshot.readCategoryMetadataCached,
  );
  const tocMarkup = renderTableOfContents(page);
  const markdownHtml = renderMarkdownBody(page);
  const markdownPath = markdownPathForDevelopmentDoc(page.relativePath);
  const descriptionMeta = page.description
    ? `<meta name="description" content="${escapeHtml(page.description)}">`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)} | HybridClaw Docs</title>
  ${descriptionMeta}
  <style>
    :root {
      color-scheme: light;
      --page-bg: #f8fafc;
      --panel-bg: #ffffff;
      --panel-muted: #f1f5f9;
      --line: #e5e7eb;
      --line-strong: #d7dee8;
      --text: #1f2937;
      --muted: #6b7280;
      --muted-strong: #4b5563;
      --brand-blue: #4a6cf7;
      --brand-blue-2: #3657e9;
      --brand-blue-soft: rgba(74, 108, 247, 0.1);
      --success: #15803d;
      --success-soft: rgba(21, 128, 61, 0.12);
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
      --nav-height: 64px;
      --sidebar-width: 300px;
      --toc-width: 250px;
      --content-width: 860px;
      --mono: "SFMono-Regular", "SF Mono", "Cascadia Code", "Consolas", monospace;
      --sans: system-ui, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    :root[data-theme="dark"] {
      color-scheme: dark;
      --page-bg: #0b1220;
      --panel-bg: #111827;
      --panel-muted: #0f172a;
      --line: #1f2937;
      --line-strong: #263347;
      --text: #e5edf7;
      --muted: #93a4b8;
      --muted-strong: #c7d2e3;
      --brand-blue: #7da2ff;
      --brand-blue-2: #9ab6ff;
      --brand-blue-soft: rgba(125, 162, 255, 0.14);
      --success: #7ee3a5;
      --success-soft: rgba(126, 227, 165, 0.16);
      --shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
    }

    * { box-sizing: border-box; }

    html {
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.65;
    }

    a {
      color: inherit;
      text-decoration: none;
    }

    code,
    pre {
      font-family: var(--mono);
    }

    .docs-topbar {
      position: sticky;
      top: 0;
      z-index: 50;
      height: var(--nav-height);
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      align-items: center;
      gap: 18px;
      padding: 0 20px;
      background: rgba(255, 255, 255, 0.9);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(18px);
    }

    :root[data-theme="dark"] .docs-topbar {
      background: rgba(11, 18, 32, 0.9);
    }

    .docs-brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      font-weight: 700;
      font-size: 1.05rem;
      color: var(--text);
    }

    .docs-brand img {
      width: 30px;
      height: 30px;
      display: block;
      border-radius: 8px;
    }

    .docs-brand-accent {
      color: var(--brand-blue);
    }

    .docs-topnav {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 20px;
      font-size: 0.96rem;
      color: var(--muted-strong);
    }

    .docs-topnav a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted-strong);
    }

    .docs-topnav a:hover {
      color: var(--brand-blue);
    }

    .docs-topnav svg {
      width: 15px;
      height: 15px;
      flex: 0 0 auto;
    }

    .docs-search-shell {
      position: relative;
      width: min(360px, 100%);
    }

    .docs-search {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 260px;
      width: 100%;
      height: 42px;
      padding: 0 12px;
      background: var(--panel-muted);
      border: 1px solid var(--line);
      border-radius: 12px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
      color: var(--muted);
    }

    .docs-search:focus-within {
      border-color: var(--brand-blue);
      box-shadow: 0 0 0 4px var(--brand-blue-soft);
    }

    .docs-search svg {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
    }

    .docs-search input {
      flex: 1 1 auto;
      min-width: 0;
      border: none;
      outline: none;
      background: transparent;
      color: var(--text);
      font: inherit;
    }

    .docs-search input::placeholder {
      color: var(--muted);
    }

    .docs-search-kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 24px;
      padding: 0 6px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: var(--panel-bg);
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1;
    }

    .docs-search-results {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      right: 0;
      background: var(--panel-bg);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .docs-search-results[hidden] {
      display: none;
    }

    .docs-search-results-list {
      display: grid;
    }

    .docs-search-result {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 2px;
    }

    .docs-search-result:last-child {
      border-bottom: none;
    }

    .docs-search-result:hover {
      background: var(--brand-blue-soft);
    }

    .docs-search-result strong {
      color: var(--text);
      font-size: 0.94rem;
    }

    .docs-search-result-meta,
    .docs-search-empty {
      color: var(--muted);
      font-size: 0.82rem;
    }

    .docs-search-empty {
      padding: 14px;
    }

    .docs-theme-toggle,
    .docs-sidebar-toggle {
      border: 1px solid var(--line);
      background: var(--panel-bg);
      color: var(--muted-strong);
      border-radius: 12px;
      height: 40px;
      padding: 0 12px;
      font: inherit;
      cursor: pointer;
    }

    .docs-sidebar-toggle {
      display: none;
      align-items: center;
      justify-content: center;
      width: 40px;
      padding: 0;
    }

    .docs-sidebar-toggle svg {
      width: 18px;
      height: 18px;
    }

    .docs-frame {
      display: grid;
      grid-template-columns: minmax(240px, var(--sidebar-width)) minmax(0, var(--content-width)) minmax(190px, var(--toc-width));
      gap: 0;
      align-items: start;
      max-width: 1560px;
      margin: 0 auto;
    }

    .docs-sidebar,
    .docs-main,
    .docs-toc {
      min-height: calc(100vh - var(--nav-height));
    }

    .docs-sidebar {
      position: sticky;
      top: var(--nav-height);
      max-height: calc(100vh - var(--nav-height));
      overflow: auto;
      padding: 22px 18px 28px;
      background: var(--panel-muted);
      border-right: 1px solid var(--line);
    }

    .docs-main {
      padding: 24px 40px 56px;
      background: var(--panel-bg);
      min-width: 0;
    }

    .docs-toc {
      position: sticky;
      top: var(--nav-height);
      max-height: calc(100vh - var(--nav-height));
      overflow: auto;
      padding: 24px 20px 32px;
      border-left: 1px solid var(--line);
      background: var(--panel-bg);
    }

    .docs-sidebar-section-title,
    .docs-toc-title {
      font-size: 0.9rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-bottom: 14px;
    }

    .docs-sidebar-section-items,
    .docs-sidebar-group-items,
    .docs-toc-links {
      display: grid;
      gap: 2px;
    }

    .docs-sidebar-link,
    .docs-toc-link {
      display: block;
      border-radius: 10px;
      transition: background 0.18s ease, color 0.18s ease;
    }

    .docs-sidebar-link {
      padding: 8px 12px;
      color: var(--muted-strong);
      font-size: 0.95rem;
    }

    .docs-sidebar-link:hover,
    .docs-toc-link:hover {
      background: var(--brand-blue-soft);
      color: var(--brand-blue);
    }

    .docs-sidebar-link.is-active {
      background: var(--panel-bg);
      color: var(--brand-blue);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.45), inset 0 0 0 1px var(--line);
      font-weight: 600;
    }

    .docs-sidebar-group {
      margin: 6px 0 2px;
    }

    .docs-sidebar-group summary {
      list-style: none;
      cursor: pointer;
      color: var(--muted);
      font-weight: 600;
      padding: 8px 10px;
      border-radius: 10px;
    }

    .docs-sidebar-group summary::-webkit-details-marker {
      display: none;
    }

    .docs-sidebar-group summary:hover {
      background: rgba(255, 255, 255, 0.5);
    }

    .docs-sidebar-group-items {
      padding-left: 10px;
      margin-top: 4px;
    }

    .docs-breadcrumbs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      color: var(--muted);
      font-size: 0.88rem;
    }

    .docs-page-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 22px;
    }

    .docs-page-actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      flex: 0 0 auto;
    }

    .docs-page-action,
    .docs-page-source-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 0 14px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: var(--panel-bg);
      color: var(--muted-strong);
      font: inherit;
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
      white-space: nowrap;
    }

    .docs-page-action:hover,
    .docs-page-source-link:hover {
      border-color: var(--brand-blue);
      color: var(--brand-blue);
      background: var(--brand-blue-soft);
      text-decoration: none;
    }

    .docs-page-action.is-copied {
      border-color: var(--success);
      color: var(--success);
      background: var(--success-soft);
    }

    .docs-breadcrumb-item a:hover {
      color: var(--brand-blue);
    }

    .docs-breadcrumb-separator {
      margin-left: 6px;
      color: var(--line-strong);
    }

    .docs-article {
      max-width: 860px;
    }

    .docs-article h1,
    .docs-article h2,
    .docs-article h3,
    .docs-article h4 {
      color: var(--text);
      letter-spacing: -0.02em;
      line-height: 1.15;
      scroll-margin-top: 88px;
    }

    .docs-article h1 {
      margin: 0 0 20px;
      font-size: clamp(2.4rem, 5vw, 3.8rem);
    }

    .docs-article h2 {
      margin: 56px 0 18px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
      font-size: clamp(1.7rem, 3vw, 2.3rem);
    }

    .docs-article h3 {
      margin: 32px 0 14px;
      font-size: 1.35rem;
    }

    .docs-article h4 {
      margin: 24px 0 12px;
      font-size: 1.05rem;
    }

    .docs-article p,
    .docs-article ul,
    .docs-article ol,
    .docs-article pre,
    .docs-article table,
    .docs-article blockquote {
      margin: 0 0 18px;
    }

    .docs-article ul,
    .docs-article ol {
      padding-left: 1.5rem;
    }

    .docs-article li + li {
      margin-top: 0.3rem;
    }

    .docs-article a {
      color: var(--brand-blue);
    }

    .docs-article a:hover {
      color: var(--brand-blue-2);
      text-decoration: underline;
    }

    .docs-article code {
      display: inline-block;
      padding: 0.08rem 0.38rem;
      border-radius: 6px;
      background: var(--panel-muted);
      border: 1px solid var(--line);
      color: var(--text);
      font-size: 0.92em;
    }

    .docs-article pre {
      padding: 16px 18px;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: var(--panel-muted);
      overflow-x: auto;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
    }

    .docs-article pre code {
      padding: 0;
      border: none;
      background: transparent;
      display: inline;
    }

    .docs-article blockquote {
      padding: 0 0 0 16px;
      border-left: 3px solid var(--brand-blue);
      color: var(--muted-strong);
    }

    .docs-article table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
    }

    .docs-article th,
    .docs-article td {
      text-align: left;
      vertical-align: top;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
    }

    .docs-article tr:last-child td {
      border-bottom: none;
    }

    .docs-article img {
      max-width: 100%;
      border: 1px solid var(--line);
      border-radius: 16px;
    }

    .docs-heading-anchor {
      opacity: 0;
      margin-left: 10px;
      color: var(--muted);
      font-size: 0.9rem;
      transition: opacity 0.18s ease;
    }

    .docs-article h1:hover .docs-heading-anchor,
    .docs-article h2:hover .docs-heading-anchor,
    .docs-article h3:hover .docs-heading-anchor,
    .docs-article h4:hover .docs-heading-anchor {
      opacity: 1;
    }

    .docs-toc-link {
      padding: 6px 10px;
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.35;
    }

    .docs-toc-link.depth-3 {
      padding-left: 22px;
    }

    .docs-toc-link.depth-4 {
      padding-left: 34px;
    }

    .docs-toc-link.is-active {
      color: var(--brand-blue);
      background: var(--brand-blue-soft);
      font-weight: 600;
    }

    .docs-toc-empty {
      color: var(--muted);
      font-size: 0.9rem;
    }

    .docs-overlay {
      display: none;
    }

    @media (max-width: 1180px) {
      .docs-frame {
        grid-template-columns: minmax(240px, var(--sidebar-width)) minmax(0, 1fr);
      }

      .docs-toc {
        display: none;
      }
    }

    @media (max-width: 960px) {
      .docs-topbar {
        grid-template-columns: auto auto 1fr auto;
        gap: 12px;
      }

      .docs-sidebar-toggle {
        display: inline-flex;
      }

      .docs-topnav {
        display: none;
      }

      .docs-search-shell {
        width: 100%;
      }

      .docs-search {
        min-width: 0;
      }

      .docs-frame {
        display: block;
      }

      .docs-sidebar {
        position: fixed;
        top: var(--nav-height);
        left: 0;
        bottom: 0;
        width: min(86vw, 320px);
        max-height: none;
        transform: translateX(-100%);
        transition: transform 0.22s ease;
        z-index: 40;
        box-shadow: var(--shadow);
      }

      body.docs-sidebar-open .docs-sidebar {
        transform: translateX(0);
      }

      .docs-main {
        padding: 22px 18px 48px;
      }

      .docs-page-head {
        flex-direction: column;
        align-items: stretch;
      }

      .docs-page-actions {
        justify-content: flex-start;
        flex-wrap: wrap;
      }

      .docs-overlay {
        position: fixed;
        inset: var(--nav-height) 0 0 0;
        background: rgba(15, 23, 42, 0.36);
        z-index: 30;
      }

      body.docs-sidebar-open .docs-overlay {
        display: block;
      }
    }

    @media (max-width: 720px) {
      .docs-topbar {
        grid-template-columns: auto 1fr auto;
      }

      .docs-search-shell {
        grid-column: 1 / -1;
      }

      .docs-topbar {
        height: auto;
        padding-top: 12px;
        padding-bottom: 12px;
      }

      .docs-sidebar,
      .docs-main {
        min-height: calc(100vh - 116px);
      }
    }
  </style>
</head>
<body>
  <header class="docs-topbar">
    <button class="docs-sidebar-toggle" type="button" data-doc-sidebar-toggle aria-label="Open documentation navigation">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14v1.5H3V5Zm0 4.25h14v1.5H3v-1.5Zm0 4.25h14V15H3v-1.5Z" fill="currentColor"></path></svg>
    </button>
    <a class="docs-brand" href="${DEVELOPMENT_DOCS_ROUTE}">
      <img src="/static/favicon.svg" alt="HybridClaw">
      <span>HybridClaw</span>
      <span class="docs-brand-accent">Docs</span>
    </a>
    <nav class="docs-topnav" aria-label="Top navigation">
      <a href="/">Home</a>
      <a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub ${renderExternalLinkIcon()}</a>
      <a href="${DISCORD_URL}" target="_blank" rel="noreferrer">Discord ${renderExternalLinkIcon()}</a>
    </nav>
    <div class="docs-search-shell">
      <label class="docs-search" aria-label="Search docs">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 12.4 17.6 16.5l-1.1 1.1-4.1-4.1a6 6 0 1 1 1.1-1.1ZM8.5 13A4.5 4.5 0 1 0 8.5 4a4.5 4.5 0 0 0 0 9Z" fill="currentColor"></path></svg>
        <input type="search" placeholder="Search docs" data-doc-search-input>
        <span class="docs-search-kbd">/</span>
        <span class="docs-search-kbd">K</span>
      </label>
      <div class="docs-search-results" data-doc-search-results hidden>
        <div class="docs-search-results-list" data-doc-search-list></div>
        <div class="docs-search-empty" data-doc-search-empty hidden>No matches yet.</div>
      </div>
    </div>
    <button class="docs-theme-toggle" type="button" data-doc-theme-toggle aria-label="Switch theme">Dark</button>
  </header>
  <div class="docs-frame">
    <aside class="docs-sidebar" aria-label="Documentation navigation">
      ${sidebarMarkup}
    </aside>
    <main class="docs-main">
      <div class="docs-page-head">
        <div class="docs-breadcrumbs" aria-label="Breadcrumb">
          ${breadcrumbsMarkup}
        </div>
        <div class="docs-page-actions">
          <button class="docs-page-action" type="button" data-doc-copy-markdown>Copy Markdown</button>
          <a class="docs-page-source-link" href="${escapeHtml(markdownPath)}">View .md</a>
        </div>
      </div>
      <article class="docs-article">
        ${markdownHtml}
      </article>
    </main>
    <aside class="docs-toc" aria-label="On this page">
      <div class="docs-toc-title">On this page</div>
      <div class="docs-toc-links">
        ${tocMarkup}
      </div>
    </aside>
  </div>
  <div class="docs-overlay" data-doc-overlay></div>
  ${renderMarkdownSourceScript(page.source)}
  ${renderSearchDataScript(snapshot.searchEntries)}
  ${renderInteractiveScript()}
</body>
</html>`;
}

function renderDevelopmentDocsErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Development Docs Error | HybridClaw Docs</title>
  <style>
    body {
      margin: 0;
      font-family: system-ui, sans-serif;
      background: #f8fafc;
      color: #1f2937;
    }

    main {
      max-width: 840px;
      margin: 0 auto;
      padding: 64px 24px;
    }

    h1 {
      margin: 0 0 16px;
      font-size: 2rem;
      line-height: 1.1;
    }

    p {
      margin: 0 0 16px;
      color: #4b5563;
    }

    pre {
      margin: 0;
      padding: 18px 20px;
      border-radius: 16px;
      background: #111827;
      color: #e5edf7;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <h1>Development docs failed to render</h1>
    <p>Fix the documentation source and reload this page.</p>
    <pre>${escapeHtml(message)}</pre>
  </main>
</body>
</html>`;
}

export function serveDevelopmentDocs(
  pathname: string,
  res: ServerResponse,
): boolean {
  const relativePath = normalizeDevelopmentDocRelativePath(pathname);
  if (!relativePath) return false;
  const wantsMarkdown = pathname.endsWith('.md');

  try {
    if (wantsMarkdown) {
      const candidate = resolveDevelopmentDocFile(relativePath);
      if (!candidate) return false;

      res.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/markdown; charset=utf-8',
      });
      res.end(fs.readFileSync(candidate, 'utf8'));
      return true;
    }

    const cachedSnapshot = getCachedDevelopmentDocsSnapshot();
    if (cachedSnapshot) {
      const cachedPage = cachedSnapshot.docsByRelativePath.get(relativePath);
      if (!cachedPage) return false;

      const html = renderPage(cachedPage, cachedSnapshot);
      res.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(html);
      return true;
    }

    const page = readDevelopmentDoc(relativePath);
    if (!page) return false;

    const snapshot = getDevelopmentDocsSnapshot(page);
    const html = renderPage(page, snapshot);
    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(html);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(renderDevelopmentDocsErrorPage(message));
    return true;
  }
}
