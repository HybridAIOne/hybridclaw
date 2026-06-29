import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadSkillDocsCatalog } from '../src/skills/skill-docs.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeDocsRoot(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-skill-docs-'));
  return tmpDir;
}

test('loadSkillDocsCatalog extracts tutorials and example prompts by skill', () => {
  const docsRoot = makeDocsRoot();
  fs.writeFileSync(
    path.join(docsRoot, 'office.md'),
    [
      '# Office',
      '',
      '## pdf',
      '',
      'Render PDF files.',
      '![PDF workflow preview](./assets/pdf-preview.png "PDF preview")',
      '',
      '> 🎯 **Try it yourself**',
      '>',
      '> `Create a PDF invoice`',
      '>',
      '> **Multi-step flow:**',
      '>',
      '> `1. Create a PDF`',
      '> `2. Extract the text`',
      '',
      '---',
      '',
      '## search.web, search.news, and search.images',
      '',
      'Search current information.',
      '',
      '> 🎯 **Try it yourself**',
      '>',
      '> `Search the web for HybridClaw docs`',
    ].join('\n'),
    'utf-8',
  );

  const catalog = loadSkillDocsCatalog(docsRoot);

  expect(catalog.get('pdf')).toMatchObject({
    title: 'pdf',
    sourcePath: 'guides/skills/office.md',
    sourceHref: '/docs/guides/skills/office#pdf',
    tutorialMarkdown: expect.stringContaining('Render PDF files.'),
    screenshots: [
      {
        src: '/docs/guides/skills/assets/pdf-preview.png',
        alt: 'PDF workflow preview',
        title: 'PDF preview',
      },
    ],
    examplePrompts: [
      { kind: 'try-it', prompt: 'Create a PDF invoice' },
      {
        kind: 'conversation',
        prompt: 'Create a PDF',
        turnIndex: 1,
        conversationId: 'pdf#conv1',
      },
      {
        kind: 'conversation',
        prompt: 'Extract the text',
        turnIndex: 2,
        conversationId: 'pdf#conv1',
      },
    ],
  });
  expect(catalog.get('search.web')?.examplePrompts).toEqual([
    { kind: 'try-it', prompt: 'Search the web for HybridClaw docs' },
  ]);
  expect(catalog.get('search.news')?.title).toBe(
    'search.web, search.news, and search.images',
  );
});
