import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir();
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unmock: ['../src/infra/install-root.js'],
});

test('docs escape stored and reflected markup while preserving raw Markdown as data', async () => {
  const root = makeTempDir('docs-security-');
  const content = path.join(root, 'docs', 'content');
  fs.mkdirSync(content, { recursive: true });
  const payload = '</script><script id="injected">alert(1)</script>';
  const source = [
    '---',
    `title: '${payload}'`,
    `description: '${payload}'`,
    '---',
    '# Security fixture',
    payload,
    '<img src=x onerror="alert(1)">',
    '[unsafe](javascript:alert%281%29)',
  ].join('\n');
  fs.writeFileSync(path.join(content, 'README.md'), source);
  fs.writeFileSync(
    path.join(content, 'navigation.json'),
    JSON.stringify({
      sections: [
        { title: payload, pages: [{ title: payload, path: 'README.md' }] },
      ],
    }),
  );
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallPath: (...parts: string[]) => path.join(root, ...parts),
  }));
  const { serveDocs } = await import('../src/gateway/docs.js');

  function expectUnhandledResponsesUntouched(): void {
    for (const route of [
      '/unrelated',
      '/docs/missing',
      '/docs/missing.md',
      '/docs/missing?search=test',
      '/docs/missing.md?search=test',
    ]) {
      const res = new ServerResponse(new IncomingMessage(new Socket()));
      res.setHeader('X-Existing', 'preserved');
      const headers = res.getHeaders();
      const end = vi.spyOn(res, 'end').mockReturnValue(res);
      expect(serveDocs(new URL(route, 'http://localhost'), res)).toBe(false);
      expect(res.getHeaders()).toEqual(headers);
      expect(res.headersSent).toBe(false);
      expect(end).not.toHaveBeenCalled();
    }
  }

  expectUnhandledResponsesUntouched();
  // Repeat the HTML route to cover both the cold and cached render paths.
  for (const route of [
    '/docs',
    '/docs',
    `/docs?search=${encodeURIComponent(payload)}`,
    '/docs/README.md',
    `/docs/README.md?search=${encodeURIComponent(payload)}`,
  ]) {
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    const writeHead = vi.spyOn(res, 'writeHead');
    const end = vi.spyOn(res, 'end').mockReturnValue(res);
    expect(serveDocs(new URL(route, 'http://localhost'), res)).toBe(true);
    expect(res.statusCode, String(end.mock.calls[0][0])).toBe(200);
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'X-Content-Type-Options': 'nosniff' }),
    );
    const body = String(end.mock.calls[0][0]);
    if (new URL(route, 'http://localhost').pathname.endsWith('.md')) {
      expect(writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': 'text/markdown; charset=utf-8',
        }),
      );
      if (route.includes('?')) {
        expect(body).toContain(payload);
      } else {
        expect(body).toBe(source);
      }
    } else {
      expect(body).not.toContain('<script id="injected">');
      expect(body).not.toContain('<img src=x');
      expect(body).not.toContain('href="javascript:');
      expect(body).toContain('&lt;');
      const embedded = body.match(
        /<script id="docs-markdown-source" type="application\/json">([\s\S]*?)<\/script>/,
      );
      expect(embedded).not.toBeNull();
      expect(embedded?.[1]).not.toContain('<');
      expect(JSON.parse(embedded?.[1] || 'null')).toContain(payload);
    }
  }
  expectUnhandledResponsesUntouched();
});
