import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, test, vi } from 'vitest';
import { setSandboxModeOverride } from '../src/config/config.js';
import { injectPdfContextMessages } from '../src/media/pdf-context.js';
import type { ChatMessage } from '../src/types/api.js';
import { writeVisualPdfFixture } from './helpers/pdf-visual-fixture.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({ cleanup: () => setSandboxModeOverride(null) });

async function pdf(root: string, name = 'document.pdf', pageCount = 6) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([400, 400]);
    if (index !== 1) page.drawText(`Page ${index + 1} evidence`);
  }
  const file = path.join(root, name);
  await fs.writeFile(file, await document.save());
  return file;
}

function preview(messages: ChatMessage[]) {
  const content = messages.at(-1)?.content;
  if (!Array.isArray(content)) throw new Error('Expected user content parts');
  const part = content.at(-1);
  if (part?.type !== 'text') throw new Error('Expected preview text');
  return JSON.parse(part.text.slice(part.text.indexOf('\n') + 1));
}

describe('PDF attachment preview', () => {
  test('leaves follow-up questions and history untouched for the model to choose reads', async () => {
    const root = tempDir();
    await writeVisualPdfFixture(root);
    for (const question of [
      'What does Figure 3 depict?',
      'Explain the sequence of symbols.',
      'Que montre cette illustration ?',
      'yes',
    ]) {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Summarize ./workshop.pdf' },
        { role: 'assistant', content: 'Five ideas.' },
        { role: 'user', content: question },
      ];
      const original = structuredClone(messages);
      expect(
        await injectPdfContextMessages({
          workspaceRoot: root,
          messages,
          visualMediaAllowed: true,
        }),
      ).toBe(messages);
      expect(messages).toEqual(original);
    }
  });

  test('previews the same initial pages regardless of the attachment question', async () => {
    const root = tempDir();
    await writeVisualPdfFixture(root);
    for (const question of [
      'Describe Figure 3',
      'Explain the sequence of symbols',
      'Describe page 7',
    ]) {
      const result = await injectPdfContextMessages({
        workspaceRoot: root,
        messages: [{ role: 'user', content: question }],
        media: [{ path: './workshop.pdf', mimeType: 'application/pdf' }],
        visualMediaAllowed: false,
      });
      const item = preview(result).previews[0];
      expect(item.processedPages).toEqual([1, 2, 3, 4]);
      expect(item.renderedPages).toEqual([]);
      expect(item).not.toHaveProperty('query');
      expect(item).not.toHaveProperty('search');
      expect(result.at(-1)?.visualAttachments).toBeUndefined();
    }
    const visual = await injectPdfContextMessages({
      workspaceRoot: root,
      messages: [{ role: 'user', content: 'Describe Figure 3' }],
      media: [{ path: './workshop.pdf', mimeType: 'application/pdf' }],
      visualMediaAllowed: true,
    });
    expect(visual.at(-1)?.visualAttachments?.[0].pages).toEqual([1, 2, 3, 4]);
    expect(preview(visual).previews[0].renderedPages).toEqual([1, 2, 3, 4]);
  });
  test.each(['?', '!'])(
    'detects a PDF path followed by %s',
    async (punctuation) => {
      const root = tempDir();
      await pdf(root);
      const result = await injectPdfContextMessages({
        workspaceRoot: root,
        messages: [
          {
            role: 'user',
            content: `What is inside ./document.pdf${punctuation}`,
          },
        ],
      });
      expect(preview(result).previews[0].pageCount).toBe(6);
    },
  );
  test('preserves original history and images, adds bounded user data with page coverage', async () => {
    const root = tempDir();
    await pdf(root);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System rules' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read "./document.pdf"' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,example' },
          },
        ],
      },
    ];
    const before = structuredClone(messages);
    const result = await injectPdfContextMessages({
      workspaceRoot: root,
      messages,
    });
    expect(messages).toEqual(before);
    expect(result.map((message) => message.role)).toEqual(['system', 'user']);
    expect(result[0]).toEqual(before[0]);
    expect((result[1].content as unknown[])[1]).toEqual(
      (before[1].content as unknown[])[1],
    );
    expect(preview(result).previews[0]).toMatchObject({
      pageCount: 6,
      processedPages: [1, 2, 3, 4],
      omittedPages: 2,
      renderedPages: [],
    });
    expect(preview(result).previews[0].pages[1]).toMatchObject({
      page: 2,
      text: '',
      needsVisualInspection: true,
    });
  });

  test('deduplicates an attachment also named in the prompt', async () => {
    const root = tempDir();
    const file = await pdf(root);
    const result = await injectPdfContextMessages({
      workspaceRoot: root,
      media: [
        { path: file, filename: 'document.pdf', mimeType: 'application/pdf' },
      ],
      messages: [{ role: 'user', content: `Read "${file}"` }],
    });
    expect(preview(result).previews).toHaveLength(1);
  });

  test('bounds the number of files and reports omissions', async () => {
    const root = tempDir();
    const files = await Promise.all(
      Array.from({ length: 5 }, (_, i) => pdf(root, `${i}.pdf`, 1)),
    );
    const result = await injectPdfContextMessages({
      workspaceRoot: root,
      messages: [
        { role: 'user', content: files.map((file) => `"${file}"`).join(' ') },
      ],
    });
    expect(preview(result).previews).toHaveLength(4);
    expect(preview(result).omittedFiles).toBe(1);
  });

  test('does not resurrect cached text on approval-only turns', async () => {
    const root = tempDir();
    await pdf(root);
    await injectPdfContextMessages({
      workspaceRoot: root,
      messages: [{ role: 'user', content: 'Read "./document.pdf"' }],
    });
    const messages: ChatMessage[] = [{ role: 'user', content: 'yes' }];
    expect(
      await injectPdfContextMessages({
        workspaceRoot: root,
        messages,
      }),
    ).toBe(messages);
  });

  test('reports missing and corrupt PDFs without fabricating content', async () => {
    const root = tempDir();
    await fs.writeFile(path.join(root, 'broken.pdf'), 'not a PDF');
    const result = await injectPdfContextMessages({
      workspaceRoot: root,
      messages: [
        { role: 'user', content: 'Read "./missing.pdf" and "./broken.pdf"' },
      ],
    });
    expect(
      preview(result).previews.every(
        (item: { status?: string }) => item.status,
      ),
    ).toBe(true);
  });

  test('rejects symlink escapes in container mode, allows explicit host paths in host mode', async () => {
    const root = tempDir();
    const outside = await pdf(tempDir());
    await fs.symlink(outside, path.join(root, 'escape.pdf'));
    setSandboxModeOverride('container');
    const result = await injectPdfContextMessages({
      workspaceRoot: root,
      messages: [{ role: 'user', content: 'Read "./escape.pdf"' }],
    });
    expect(preview(result).previews[0].pageCount).toBeUndefined();
    setSandboxModeOverride('host');
    const allowed = await injectPdfContextMessages({
      workspaceRoot: root,
      messages: [{ role: 'user', content: `Read "${outside}"` }],
    });
    expect(preview(allowed).previews[0].pageCount).toBe(6);
  });

  test('without the agent runtime (pnpm, --ignore-scripts) the preview fails soft and logs the repair command once', async () => {
    const root = tempDir();
    await pdf(root);
    const installRoot = tempDir();
    vi.resetModules();
    vi.doMock('../src/infra/install-root.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/infra/install-root.js')>()),
      resolveInstallRoot: () => installRoot,
      resolveInstallPath: (...segments: string[]) =>
        path.join(installRoot, ...segments),
    }));
    try {
      const { logger } = await import('../src/logger.js');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const { injectPdfContextMessages: inject } = await import(
        '../src/media/pdf-context.js'
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await inject({
          workspaceRoot: root,
          messages: [{ role: 'user', content: 'Summarize ./document.pdf' }],
        });
        expect(preview(result).previews[0].status).toContain(
          'PDF preview failed',
        );
      }
      expect(warn).toHaveBeenCalledOnce();
      const message = String(warn.mock.calls[0]?.[1]);
      expect(message).toContain(path.join(installRoot, 'container', 'node_modules'));
      expect(message).toContain('--ignore-scripts');
    } finally {
      vi.doUnmock('../src/infra/install-root.js');
      vi.resetModules();
    }
  });
});
