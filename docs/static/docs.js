const DOCS_BASE_PATH = '/docs';
const LEGACY_DOCS_BASE_PATH = '/development';
const GITHUB_REPO_URL = 'https://github.com/HybridAIOne/hybridclaw';
const DISCORD_URL = 'https://discord.gg/jsVW4vJw27';
const SEARCH_RESULT_LIMIT = 10;

export const DEVELOPMENT_DOCS_SECTIONS = [
  {
    title: 'Overview',
    pages: [{ title: 'HybridClaw Docs', path: 'README.md' }],
  },
  {
    title: 'Getting Started',
    pages: [
      { title: 'Getting Started', path: 'getting-started/README.md' },
      { title: 'Installation', path: 'getting-started/installation.md' },
      { title: 'Quick Start', path: 'getting-started/quickstart.md' },
      { title: 'Authentication', path: 'getting-started/authentication.md' },
      { title: 'Channel Setup', path: 'getting-started/channels.md' },
    ],
  },
  {
    title: 'Guides',
    pages: [
      { title: 'Guides', path: 'guides/README.md' },
      { title: 'Bundled Skills', path: 'guides/bundled-skills.md' },
      { title: 'Local Providers', path: 'guides/local-providers.md' },
      { title: 'Remote Access', path: 'guides/remote-access.md' },
      { title: 'Office Dependencies', path: 'guides/office-dependencies.md' },
      { title: 'TUI MCP', path: 'guides/tui-mcp.md' },
      { title: 'Voice TTS', path: 'guides/voice-tts.md' },
    ],
  },
  {
    title: 'Extensibility',
    pages: [
      { title: 'Extensibility', path: 'extensibility/README.md' },
      { title: 'Adaptive Skills', path: 'extensibility/adaptive-skills.md' },
      { title: 'Agent Packages', path: 'extensibility/agent-packages.md' },
      {
        title: 'MemPalace Memory Plugin',
        path: 'extensibility/mempalace-memory-plugin.md',
      },
      { title: 'OTEL Plugin', path: 'extensibility/otel-plugin.md' },
      { title: 'Plugins', path: 'extensibility/plugins.md' },
      {
        title: 'QMD Memory Plugin',
        path: 'extensibility/qmd-memory-plugin.md',
      },
      { title: 'Skills', path: 'extensibility/skills.md' },
    ],
  },
  {
    title: 'Internals',
    pages: [
      { title: 'Internals', path: 'internals/README.md' },
      { title: 'Architecture', path: 'internals/architecture.md' },
      { title: 'Runtime', path: 'internals/runtime.md' },
      { title: 'Session Routing', path: 'internals/session-routing.md' },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { title: 'Reference', path: 'reference/README.md' },
      { title: 'Commands', path: 'reference/commands.md' },
      { title: 'Configuration', path: 'reference/configuration.md' },
      { title: 'Diagnostics', path: 'reference/diagnostics.md' },
      { title: 'FAQ', path: 'reference/faq.md' },
      { title: 'Model Selection', path: 'reference/model-selection.md' },
    ],
  },
];

const DOCS_BY_PATH = new Map(
  DEVELOPMENT_DOCS_SECTIONS.flatMap((section) =>
    section.pages.map((page) => [page.path, page]),
  ),
);
const KNOWN_DOC_PATHS = new Set(DOCS_BY_PATH.keys());
const DOCS_SEARCH_ENTRIES = DEVELOPMENT_DOCS_SECTIONS.flatMap((section) =>
  section.pages.map((page) => ({
    label: page.title,
    parentTitle: section.title,
    routePath: buildDocHtmlHref(page.path),
  })),
);

export function normalizeDocPath(input) {
  return String(input || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function normalizeBasePath(basePath = DOCS_BASE_PATH) {
  const normalized = normalizeDocPath(basePath);
  return normalized ? `/${normalized.replace(/\/$/, '')}` : '';
}

function splitHref(rawHref) {
  const href = String(rawHref || '').trim();
  if (!href) {
    return { path: '', search: '', hash: '' };
  }

  const hashIndex = href.indexOf('#');
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const queryIndex = beforeHash.indexOf('?');
  return {
    path: queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash,
    search: queryIndex >= 0 ? beforeHash.slice(queryIndex) : '',
    hash,
  };
}

function normalizeSegments(input) {
  const segments = [];
  for (const segment of normalizeDocPath(input).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function resolveRelativePath(fromPath, relativePath) {
  const fromSegments = normalizeSegments(fromPath);
  if (!fromPath.endsWith('/')) {
    fromSegments.pop();
  }
  const nextSegments = [...fromSegments];
  for (const segment of normalizeDocPath(relativePath).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      nextSegments.pop();
      continue;
    }
    nextSegments.push(segment);
  }
  return nextSegments.join('/');
}

export function resolveDocPathFromPathname(
  pathname,
  basePath = DOCS_BASE_PATH,
) {
  const normalizedBasePath = normalizeBasePath(basePath);
  const rawPathname =
    String(pathname || '')
      .split('?')[0]
      .split('#')[0] || '/';
  let remainder = rawPathname;

  if (normalizedBasePath && remainder.startsWith(normalizedBasePath)) {
    remainder = remainder.slice(normalizedBasePath.length);
  } else if (
    normalizedBasePath !== LEGACY_DOCS_BASE_PATH &&
    remainder.startsWith(LEGACY_DOCS_BASE_PATH)
  ) {
    remainder = remainder.slice(LEGACY_DOCS_BASE_PATH.length);
  }

  remainder = normalizeDocPath(remainder);
  if (!remainder || remainder === 'index.html') {
    return 'README.md';
  }
  if (remainder.endsWith('/')) {
    return `${remainder}README.md`;
  }
  if (remainder.endsWith('.html')) {
    return `${remainder.slice(0, -'.html'.length)}.md`;
  }
  if (remainder.endsWith('.md')) {
    return remainder;
  }
  return `${remainder}.md`;
}

export function buildDocHtmlHref(docPath, basePath = DOCS_BASE_PATH) {
  const normalizedBasePath = normalizeBasePath(basePath);
  const normalizedDocPath = normalizeDocPath(docPath);
  if (!normalizedDocPath || normalizedDocPath === 'README.md') {
    return `${normalizedBasePath}/`;
  }
  if (normalizedDocPath.endsWith('/README.md')) {
    return `${normalizedBasePath}/${normalizedDocPath.slice(0, -'README.md'.length)}`;
  }
  return `${normalizedBasePath}/${normalizedDocPath.slice(0, -'.md'.length)}`;
}

export function buildDocMarkdownHref(
  docPath,
  basePath = DOCS_BASE_PATH,
  contentBasePath = basePath,
) {
  return `${normalizeBasePath(contentBasePath)}/${normalizeDocPath(docPath)}`;
}

function renderExternalLinkIcon() {
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 2h4v4h-1.5V4.56L7.03 10.03l-1.06-1.06L11.44 3.5H10V2ZM3 4h4v1.5H4.5v6h6V9H12v4H3V4Z" fill="currentColor"></path></svg>';
}

function resolvePageCandidate(currentDocPath, rawHref) {
  const { path, search, hash } = splitHref(rawHref);
  if (!path) {
    return { href: `${hash || ''}`, external: false };
  }
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('mailto:')
  ) {
    return { href: `${path}${search}${hash}`, external: true };
  }
  if (path.startsWith('/')) {
    return { href: `${path}${search}${hash}`, external: false };
  }

  const currentDir = currentDocPath.includes('/')
    ? currentDocPath.slice(0, currentDocPath.lastIndexOf('/') + 1)
    : '';
  const resolvedPath = resolveRelativePath(currentDir, path);
  return { href: resolvedPath, suffix: `${search}${hash}`, external: false };
}

export function resolveDocLinkHref(
  currentDocPath,
  rawHref,
  basePath = DOCS_BASE_PATH,
) {
  const resolved = resolvePageCandidate(currentDocPath, rawHref);
  if (resolved.external || resolved.href.startsWith('/')) {
    return resolved.href;
  }
  if (!resolved.href) {
    return resolved.suffix || '#';
  }

  if (resolved.href.endsWith('.md')) {
    if (KNOWN_DOC_PATHS.has(resolved.href)) {
      return `${buildDocHtmlHref(resolved.href, basePath)}${resolved.suffix || ''}`;
    }
    return `/${resolved.href}${resolved.suffix || ''}`;
  }

  const withMarkdownExtension = `${resolved.href}.md`;
  if (KNOWN_DOC_PATHS.has(withMarkdownExtension)) {
    return `${buildDocHtmlHref(withMarkdownExtension, basePath)}${resolved.suffix || ''}`;
  }
  const readmePath = `${resolved.href.replace(/\/$/, '')}/README.md`;
  if (KNOWN_DOC_PATHS.has(readmePath)) {
    return `${buildDocHtmlHref(readmePath, basePath)}${resolved.suffix || ''}`;
  }
  return `/${resolved.href}${resolved.suffix || ''}`;
}

function resolveAssetHref(currentDocPath, rawHref, basePath = DOCS_BASE_PATH) {
  const resolved = resolvePageCandidate(currentDocPath, rawHref);
  if (resolved.external || resolved.href.startsWith('/')) {
    return resolved.href;
  }
  if (!resolved.href) {
    return '#';
  }
  if (resolved.href.endsWith('.md')) {
    return resolveDocLinkHref(currentDocPath, rawHref, basePath);
  }
  return `/${resolved.href}${resolved.suffix || ''}`;
}

export function parseFrontmatter(rawMarkdown) {
  const text = String(rawMarkdown || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return { metadata: {}, body: text };
  }

  const closingIndex = text.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return { metadata: {}, body: text };
  }

  const metadata = {};
  const frontmatter = text.slice(4, closingIndex).split('\n');
  for (const line of frontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!match) continue;
    metadata[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }

  return {
    metadata,
    body: text.slice(closingIndex + '\n---\n'.length),
  };
}

function escapeHtml(raw) {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripMarkdownFormatting(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .trim();
}

function slugifyHeading(text, slugCounts) {
  const base =
    stripMarkdownFormatting(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  const nextCount = (slugCounts.get(base) || 0) + 1;
  slugCounts.set(base, nextCount);
  return nextCount === 1 ? base : `${base}-${nextCount}`;
}

function splitTableRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableSeparatorLine(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(
    String(line || ''),
  );
}

function renderInlineMarkdown(raw, context) {
  let text = String(raw || '');
  const inlineCode = [];
  const images = [];
  const links = [];

  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const index = inlineCode.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `@@IC${index}@@`;
  });

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, href) => {
    const source = resolveAssetHref(
      context.currentDocPath,
      href,
      context.basePath,
    );
    const index =
      images.push(
        `<img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" loading="lazy">`,
      ) - 1;
    return `@@IM${index}@@`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const target = resolveDocLinkHref(
      context.currentDocPath,
      href,
      context.basePath,
    );
    const external =
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('mailto:');
    const index =
      links.push(
        `<a href="${escapeHtml(target)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>`,
      ) - 1;
    return `@@LK${index}@@`;
  });

  text = escapeHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/_([^_]+)_/g, '<em>$1</em>');
  text = text.replace(
    /@@LK(\d+)@@/g,
    (_match, index) => links[Number(index)] || '',
  );
  text = text.replace(
    /@@IM(\d+)@@/g,
    (_match, index) => images[Number(index)] || '',
  );
  text = text.replace(
    /@@IC(\d+)@@/g,
    (_match, index) => inlineCode[Number(index)] || '',
  );
  return text;
}

export function renderMarkdownToHtml(rawMarkdown, options = {}) {
  const context = {
    currentDocPath: normalizeDocPath(options.currentDocPath || 'README.md'),
    basePath: options.basePath || DOCS_BASE_PATH,
  };
  const text = String(rawMarkdown || '').replace(/\r\n/g, '\n');
  const codeBlocks = [];
  const headings = [];
  const slugCounts = new Map();
  const lines = text
    .replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const className = String(lang || '').trim();
      const index =
        codeBlocks.push(
          `<pre><code${className ? ` class="language-${escapeHtml(className)}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`,
        ) - 1;
      return `@@CB${index}@@`;
    })
    .split('\n');

  const html = [];
  let paragraphLines = [];
  let openList = '';

  const closeList = () => {
    if (openList) {
      html.push(openList === 'ul' ? '</ul>' : '</ol>');
      openList = '';
    }
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    html.push(
      `<p>${paragraphLines
        .map((line) => renderInlineMarkdown(line, context))
        .join('<br>')}</p>`,
    );
    paragraphLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || '';

    const codeMatch = line.match(/^@@CB(\d+)@@$/);
    if (codeMatch) {
      flushParagraph();
      closeList();
      html.push(codeBlocks[Number(codeMatch[1])] || '');
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      // Look ahead past blank lines: keep the list open when the next
      // non-empty line continues the same list type (#206)
      if (openList) {
        let ahead = index + 1;
        while (ahead < lines.length && !(lines[ahead] || '').trim()) ahead++;
        const nextNonEmpty = ahead < lines.length ? lines[ahead] : '';
        const continuesList =
          (openList === 'ul' && /^\s*[-*+]\s+/.test(nextNonEmpty)) ||
          (openList === 'ol' && /^\s*\d+\.\s+/.test(nextNonEmpty));
        if (!continuesList) closeList();
      }
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const textContent = heading[2];
      const level = heading[1].length;
      const slug = slugifyHeading(textContent, slugCounts);
      headings.push({
        level,
        slug,
        text: stripMarkdownFormatting(textContent),
      });
      html.push(
        `<h${level} id="${escapeHtml(slug)}"><a class="docs-anchor-link" href="#${escapeHtml(slug)}">${renderInlineMarkdown(textContent, context)}</a></h${level}>`,
      );
      continue;
    }

    if (isTableSeparatorLine(lines[index + 1] || '')) {
      flushParagraph();
      closeList();
      const headerCells = splitTableRow(line);
      const bodyRows = [];
      index += 2;
      while (index < lines.length && /\|/.test(lines[index] || '')) {
        bodyRows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      html.push('<table><thead><tr>');
      for (const cell of headerCells) {
        html.push(`<th>${renderInlineMarkdown(cell, context)}</th>`);
      }
      html.push('</tr></thead>');
      if (bodyRows.length > 0) {
        html.push('<tbody>');
        for (const row of bodyRows) {
          html.push('<tr>');
          for (const cell of row) {
            html.push(`<td>${renderInlineMarkdown(cell, context)}</td>`);
          }
          html.push('</tr>');
        }
        html.push('</tbody>');
      }
      html.push('</table>');
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(
        `<blockquote>${renderInlineMarkdown(quote[1], context)}</blockquote>`,
      );
      continue;
    }

    const divider = line.match(/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/);
    if (divider) {
      flushParagraph();
      closeList();
      html.push('<hr>');
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      if (openList !== 'ul') {
        closeList();
        html.push('<ul>');
        openList = 'ul';
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1], context)}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (openList !== 'ol') {
        closeList();
        html.push('<ol>');
        openList = 'ol';
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1], context)}</li>`);
      continue;
    }

    closeList();
    paragraphLines.push(line);
  }

  flushParagraph();
  closeList();

  return {
    html: html.join(''),
    headings,
  };
}

function copyTextFallback(text) {
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'absolute';
  helper.style.left = '-9999px';
  document.body.appendChild(helper);
  helper.select();
  document.execCommand('copy');
  document.body.removeChild(helper);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  copyTextFallback(text);
}

function derivePageTitle(docPath) {
  return DOCS_BY_PATH.get(docPath)?.title || stripMarkdownFormatting(docPath);
}

function findSectionForDocPath(docPath) {
  return (
    DEVELOPMENT_DOCS_SECTIONS.find((section) =>
      section.pages.some((page) => page.path === docPath),
    ) || null
  );
}

function renderBreadcrumbs(docPath, basePath) {
  const items = [
    { label: 'Home', href: '/' },
    { label: 'Documentation', href: buildDocHtmlHref('README.md', basePath) },
  ];

  const section = findSectionForDocPath(docPath);
  if (section && section.title !== 'Overview') {
    items.push({
      label: section.title,
      href: buildDocHtmlHref(section.pages[0]?.path || 'README.md', basePath),
    });
  }

  items.push({ label: derivePageTitle(docPath), href: null });

  return items
    .map((item, index) => {
      const body = item.href
        ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`
        : `<span aria-current="page">${escapeHtml(item.label)}</span>`;
      const suffix =
        index === items.length - 1
          ? ''
          : '<span class="docs-breadcrumb-separator">/</span>';
      return `<span class="docs-breadcrumb-item">${body}${suffix}</span>`;
    })
    .join('');
}

function renderSidebar(currentDocPath, basePath) {
  return DEVELOPMENT_DOCS_SECTIONS.map((section) => {
    const links = section.pages
      .map((page) => {
        const activeClass = page.path === currentDocPath ? ' is-active' : '';
        return `<a class="docs-nav-link${activeClass}" href="${escapeHtml(
          buildDocHtmlHref(page.path, basePath),
        )}">${escapeHtml(page.title)}</a>`;
      })
      .join('');
    return `<section class="docs-nav-group"><h2>${escapeHtml(
      section.title,
    )}</h2>${links}</section>`;
  }).join('');
}

function renderToc(headings) {
  const visibleHeadings = Array.isArray(headings)
    ? headings.filter((heading) => heading.level >= 2 && heading.level <= 4)
    : [];
  if (visibleHeadings.length === 0) {
    return '<div class="docs-toc-empty">This page has no sectional headings.</div>';
  }
  const links = visibleHeadings
    .map(
      (heading) =>
        `<a class="docs-toc-link docs-toc-link-level-${heading.level}" href="#${escapeHtml(
          heading.slug,
        )}">${escapeHtml(heading.text)}</a>`,
    )
    .join('');
  return `<nav class="docs-toc"><div class="docs-toc-label">On this page</div>${links}</nav>`;
}

function scrollToHash() {
  if (typeof window === 'undefined' || !window.location.hash) return;
  const targetId = decodeURIComponent(window.location.hash.slice(1));
  if (!targetId) return;
  const target = document.getElementById(targetId);
  if (!target) return;
  window.requestAnimationFrame(() => {
    target.scrollIntoView({ block: 'start' });
  });
}

function renderNotFoundState(mount, docPath, basePath) {
  document.title = 'Docs Not Found · HybridClaw';
  mount.innerHTML = `
    <div class="docs-app-shell">
      <header class="docs-topbar">
        <a class="docs-brand" href="${escapeHtml(
          buildDocHtmlHref('README.md', basePath),
        )}">
          <img src="/static/hybridclaw-logo.svg" alt="HybridClaw">
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
        <aside class="docs-sidebar">
          <div class="docs-nav">${renderSidebar('', basePath)}</div>
        </aside>
        <main class="docs-main">
          <div class="docs-page-head">
            <div class="docs-breadcrumbs" aria-label="Breadcrumb">
              ${renderBreadcrumbs('README.md', basePath)}
            </div>
            <div class="docs-page-actions">
              <a class="docs-page-source-link" href="${escapeHtml(
                buildDocMarkdownHref('README.md', basePath),
              )}">View .md</a>
            </div>
          </div>
          <article class="docs-article">
            <div class="docs-content">
              <h1>Page Not Found</h1>
              <p>No development doc matched <code>${escapeHtml(docPath)}</code>.</p>
              <p>Use the sidebar to open an existing page, or go back to <a href="${escapeHtml(
                buildDocHtmlHref('README.md', basePath),
              )}">the docs index</a>.</p>
            </div>
          </article>
        </main>
        <aside class="docs-toc" aria-label="On this page">
          <div class="docs-toc-title">On this page</div>
          <div class="docs-toc-links">
            <div class="docs-toc-empty">Open an existing page from the sidebar.</div>
          </div>
        </aside>
      </div>
    </div>
  `;
}

export async function mountDocsApp(options = {}) {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return false;
  }

  const basePath = options.basePath || DOCS_BASE_PATH;
  const contentBasePath = options.contentBasePath || basePath;
  const mount = document.querySelector(
    options.mountSelector || '[data-docs-app]',
  );
  const fallback = document.querySelector(
    options.fallbackSelector || '[data-docs-fallback]',
  );
  if (!mount) {
    return false;
  }

  const pathname = window.location.pathname || '/';
  if (
    options.allowFallback === true &&
    !pathname.startsWith(normalizeBasePath(basePath))
  ) {
    mount.setAttribute('hidden', 'hidden');
    if (fallback) {
      fallback.removeAttribute('hidden');
    }
    document.title = 'Page Not Found · HybridClaw';
    return false;
  }

  if (fallback) {
    fallback.setAttribute('hidden', 'hidden');
  }
  mount.removeAttribute('hidden');

  const docPath = resolveDocPathFromPathname(pathname, basePath);
  if (!KNOWN_DOC_PATHS.has(docPath)) {
    renderNotFoundState(mount, docPath, basePath);
    return false;
  }

  const markdownHref = buildDocMarkdownHref(docPath, basePath, contentBasePath);
  const response = await fetch(markdownHref, { cache: 'no-store' });
  if (!response.ok) {
    renderNotFoundState(mount, docPath, basePath);
    return false;
  }

  const rawMarkdown = await response.text();
  const { metadata, body } = parseFrontmatter(rawMarkdown);
  const { html, headings } = renderMarkdownToHtml(body, {
    currentDocPath: docPath,
    basePath,
  });
  const pageTitle = metadata.title || derivePageTitle(docPath);
  document.title = `${pageTitle} · HybridClaw Docs`;
  mount.innerHTML = `
    <div class="docs-app-shell">
      <header class="docs-topbar">
        <a class="docs-brand" href="${escapeHtml(
          buildDocHtmlHref('README.md', basePath),
        )}">
          <img src="/static/hybridclaw-logo.svg" alt="HybridClaw">
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
        <aside class="docs-sidebar">
          <div class="docs-nav">${renderSidebar(docPath, basePath)}</div>
        </aside>
        <main class="docs-main">
          <div class="docs-page-head">
            <div class="docs-breadcrumbs" aria-label="Breadcrumb">
              ${renderBreadcrumbs(docPath, basePath)}
            </div>
            <div class="docs-page-actions">
              <button type="button" class="docs-page-action" data-copy-markdown>Copy Markdown</button>
              <a class="docs-page-source-link" href="${escapeHtml(markdownHref)}">View .md</a>
            </div>
          </div>
          <article class="docs-article">
            <div class="docs-content">${html}</div>
          </article>
        </main>
        <aside class="docs-toc" aria-label="On this page">
          <div class="docs-toc-title">On this page</div>
          <div class="docs-toc-links">
            ${renderToc(headings)}
          </div>
        </aside>
      </div>
    </div>
  `;

  const copyButton = mount.querySelector('[data-copy-markdown]');
  const searchInput = mount.querySelector('[data-doc-search-input]');
  const searchResults = mount.querySelector('[data-doc-search-results]');
  const searchEmpty = mount.querySelector('[data-doc-search-empty]');
  const searchList = mount.querySelector('[data-doc-search-list]');
  const themeToggle = mount.querySelector('[data-doc-theme-toggle]');
  if (copyButton instanceof HTMLButtonElement) {
    copyButton.addEventListener('click', async () => {
      try {
        await copyText(rawMarkdown);
        const previousText = copyButton.textContent;
        copyButton.textContent = 'Copied';
        copyButton.classList.add('is-copied');
        window.setTimeout(() => {
          copyButton.textContent = previousText || 'Copy Markdown';
          copyButton.classList.remove('is-copied');
        }, 1200);
      } catch {
        copyButton.textContent = 'Copy failed';
      }
    });
  }

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('hybridclaw-docs-theme', theme);
    } catch {}
    if (themeToggle instanceof HTMLButtonElement) {
      themeToggle.setAttribute(
        'aria-label',
        theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      );
      themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
    }
  };

  let initialTheme = 'light';
  try {
    const storedTheme = localStorage.getItem('hybridclaw-docs-theme');
    if (storedTheme === 'light' || storedTheme === 'dark') {
      initialTheme = storedTheme;
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      initialTheme = 'dark';
    }
  } catch {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      initialTheme = 'dark';
    }
  }
  applyTheme(initialTheme);

  if (themeToggle instanceof HTMLButtonElement) {
    themeToggle.addEventListener('click', () => {
      applyTheme(
        document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark',
      );
    });
  }

  const renderSearchResults = (query) => {
    if (
      !(searchInput instanceof HTMLInputElement) ||
      !(searchResults instanceof HTMLElement) ||
      !(searchEmpty instanceof HTMLElement) ||
      !(searchList instanceof HTMLElement)
    ) {
      return [];
    }

    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      searchResults.hidden = true;
      searchList.innerHTML = '';
      searchEmpty.hidden = true;
      return [];
    }

    const matches = DOCS_SEARCH_ENTRIES.filter((entry) => {
      const haystack = `${entry.label} ${entry.parentTitle}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    }).slice(0, SEARCH_RESULT_LIMIT);

    searchList.innerHTML = '';
    searchResults.hidden = false;
    searchEmpty.hidden = matches.length !== 0;

    for (const entry of matches) {
      const link = document.createElement('a');
      link.className = 'docs-search-result';
      link.href = entry.routePath;

      const title = document.createElement('strong');
      title.textContent = entry.label;
      link.appendChild(title);

      const meta = document.createElement('span');
      meta.className = 'docs-search-result-meta';
      meta.textContent = entry.parentTitle;
      link.appendChild(meta);

      searchList.appendChild(link);
    }

    return matches;
  };

  const isEditableTarget = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT');

  if (searchInput instanceof HTMLInputElement) {
    searchInput.addEventListener('input', () => {
      renderSearchResults(searchInput.value || '');
    });
    searchInput.addEventListener('focus', () => {
      renderSearchResults(searchInput.value || '');
    });
    searchInput.addEventListener('keydown', (event) => {
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
  }

  document.addEventListener('click', (event) => {
    if (
      searchResults instanceof HTMLElement &&
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
      if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
        searchInput.select();
      }
      return;
    }
    if (
      event.key === 'Escape' &&
      searchInput instanceof HTMLInputElement &&
      document.activeElement === searchInput
    ) {
      searchInput.blur();
    }
  });

  scrollToHash();
  return true;
}
