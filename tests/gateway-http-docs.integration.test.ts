/**
 * Integration test: Real HTTP server + docs rendering.
 *
 * Starts a real HTTP server using the gateway's `serveDocs` handler,
 * reads real markdown files from disk, and verifies HTML rendering,
 * raw markdown serving, search, and redirects.
 */

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveInstallPath } from '../src/infra/install-root.js';

let server: http.Server;
let baseUrl: string;

// Dynamic import of serveDocs — resolved after server setup.
let serveDocs: typeof import('../src/gateway/docs.js').serveDocs;

beforeAll(async () => {
  // Import docs module — it resolves install root from the package tree,
  // and SITE_DIR/DEVELOPMENT_DOCS_DIR from the real docs/ directory.
  const docsModule = await import('../src/gateway/docs.js');
  serveDocs = docsModule.serveDocs;

  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    const handled = serveDocs(url, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('gateway docs HTTP integration', () => {
  it('GET /docs renders HTML with Getting Started', async () => {
    const res = await fetch(`${baseUrl}/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Getting Started');
    expect(html).toContain('<h1 id="hybridclaw-docs">HybridClaw Docs');
    expect(html).not.toContain('id="title-hybridclaw-docs');
  });

  it('GET /docs/developer-guide renders the section index without frontmatter leakage', async () => {
    const res = await fetch(`${baseUrl}/docs/developer-guide`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<h1 id="developer-guide">Developer Guide');
    expect(html).not.toContain('id="title-developer-guide');
  });

  it('GET /docs/getting-started renders section page with authentication link', async () => {
    const res = await fetch(`${baseUrl}/docs/getting-started`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html.toLowerCase()).toContain('authentication');
  });

  it('GET /docs/getting-started/README.md serves raw markdown with correct content-type', async () => {
    const res = await fetch(`${baseUrl}/docs/getting-started/README.md`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('text/markdown');
    const body = await res.text();
    // The raw markdown should contain frontmatter or heading text.
    expect(body).toContain('Getting Started');
  });

  it('GET /docs?search=install returns search results', async () => {
    const res = await fetch(`${baseUrl}/docs?search=install`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // Search results page should mention the search term or contain result markup.
    expect(html.toLowerCase()).toContain('install');
  });

  it('GET /development/getting-started returns a marked legacy redirect to /docs/getting-started', async () => {
    const res = await fetch(`${baseUrl}/development/getting-started`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(308);
    const location = res.headers.get('location') || '';
    expect(location).toBe('/docs/getting-started');
    expect(res.headers.get('x-hybridclaw-docs-redirect')).toBe('legacy');
  });

  it('GET /docs/getting-started/channels returns a marked legacy redirect to /docs/channels/overview', async () => {
    const res = await fetch(`${baseUrl}/docs/getting-started/channels`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(308);
    const location = res.headers.get('location') || '';
    expect(location).toBe('/docs/channels/overview');
    expect(res.headers.get('x-hybridclaw-docs-redirect')).toBe('legacy');
  });

  it('docs with missing file returns 404 (not a crash)', async () => {
    const res = await fetch(
      `${baseUrl}/docs/this-section-does-not-exist-at-all`,
    );
    // serveDocs returns false for unknown paths, so our wrapper returns 404.
    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
  });

  // --- All markdown files render ---

  it('every markdown file in docs/content/ renders as 200 HTML', async () => {
    const docsDir = resolveInstallPath('docs', 'content');

    function collectMarkdownFiles(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...collectMarkdownFiles(fullPath));
        } else if (entry.name.endsWith('.md') && entry.name !== 'README.md') {
          results.push(fullPath);
        }
      }
      return results;
    }

    const mdFiles = collectMarkdownFiles(docsDir);
    expect(mdFiles.length).toBeGreaterThan(0);

    await Promise.all(
      mdFiles.map(async (filePath) => {
        const relative = path.relative(docsDir, filePath);
        const urlPath = `/docs/${relative.replace(/\.md$/, '').replace(/\\/g, '/')}`;
        const res = await fetch(`${baseUrl}${urlPath}`);
        expect(
          res.status,
          `Expected 200 for ${urlPath} but got ${res.status}`,
        ).toBe(200);
        const html = await res.text();
        expect(
          html.length,
          `Expected non-empty HTML for ${urlPath}`,
        ).toBeGreaterThan(0);
      }),
    );
  });

  // --- Sidebar contains all top-level sections ---

  it('sidebar contains links for all top-level sections', async () => {
    const res = await fetch(`${baseUrl}/docs`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const expectedSections = [
      'getting-started',
      'channels',
      'guides',
      'reference',
      'extensibility',
      'developer-guide',
    ];
    for (const section of expectedSections) {
      expect(html, `Sidebar should contain a link for "${section}"`).toContain(
        `/docs/${section}`,
      );
    }
  });

  // --- Internal doc links resolve ---

  it('all internal /docs/ links on the index page resolve to 200', async () => {
    const res = await fetch(`${baseUrl}/docs`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Extract all href values that start with /docs/.
    const linkRegex = /href="(\/docs\/[^"#]*)"/g;
    const links = new Set<string>();
    let linkMatch = linkRegex.exec(html);
    while (linkMatch !== null) {
      links.add(linkMatch[1]);
      linkMatch = linkRegex.exec(html);
    }

    expect(
      links.size,
      'Expected at least one internal /docs/ link',
    ).toBeGreaterThan(0);

    await Promise.all(
      [...links].map(async (link) => {
        const linkRes = await fetch(`${baseUrl}${link}`);
        expect(
          linkRes.status,
          `Internal link ${link} should resolve to 200 but got ${linkRes.status}`,
        ).toBe(200);
        await linkRes.text();
      }),
    );
  });
});
