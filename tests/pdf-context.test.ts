import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, test } from 'vitest';
import { setSandboxModeOverride } from '../src/config/config.js';
import { injectPdfContextMessages } from '../src/media/pdf-context.js';
import type { ChatMessage } from '../src/types/api.js';
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
});
