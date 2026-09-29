import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, test, vi } from 'vitest';
import { readPdfPages } from '../container/shared/pdf-reader.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({
  unstubAllEnvs: true,
  unstubAllGlobals: true,
  resetModules: true,
});
const runtimeUrl = pathToFileURL(
  path.resolve('skills/pdf/scripts/_pdf_runtime.mjs'),
).href;
async function fixture() {
  const root = tempDir();
  const document = await PDFDocument.create();
  for (let i = 0; i < 6; i += 1) {
    const page = document.addPage([400, 400]);
    if (i !== 1)
      page.drawText('Readable document evidence '.repeat(5), {
        x: 20,
        y: 300,
        size: 8,
        maxWidth: 350,
      });
  }
  const file = path.join(root, 'document.pdf');
  await fs.writeFile(file, await document.save());
  return { root, file };
}

describe('bounded PDF read', () => {
  test('reads selected pages with original numbering and explicit text truncation', async () => {
    const { file } = await fixture();
    const result = await readPdfPages(file, {
      pages: '3,5-6',
      render: 'never',
      maxChars: 10,
      runtimeUrl,
    });
    expect(result.processedPages).toEqual([3, 5, 6]);
    expect(result.omittedPages).toBe(3);
    expect(result.pages.map((page) => page.page)).toEqual([3, 5, 6]);
    expect(result.pages.reduce((sum, page) => sum + page.text.length, 0)).toBe(
      10,
    );
    expect(result.pages.every((page) => page.textTruncated)).toBe(true);
  });

  test.each(['', '0', '2-1', '1x', '1-9999999999', '1,2,3,4,5', '7'])(
    'rejects invalid or excessive selection %j',
    async (pages) => {
      const { file } = await fixture();
      await expect(readPdfPages(file, { pages, runtimeUrl })).rejects.toThrow();
    },
  );

  test('auto renders sparse pages, always renders text-rich pages, with bounded image dimensions', async () => {
    const { file, root } = await fixture();
    const automatic = await readPdfPages(file, {
      pages: '1-2',
      outputDir: path.join(root, 'auto'),
      runtimeUrl,
    });
    expect(automatic.images.map((image) => image.page)).toEqual([2]);
    const visual = await readPdfPages(file, {
      pages: '1',
      render: 'always',
      outputDir: path.join(root, 'visual'),
      runtimeUrl,
    });
    expect(visual.images.map((image) => image.page)).toEqual([1]);
    const png = await fs.readFile(visual.images[0].path);
    expect(png.readUInt32BE(16)).toBe(1600);
    expect(png.readUInt32BE(20)).toBe(1600);
  });

  test('reports rendering failure while retaining extracted text', async () => {
    const { file, root } = await fixture();
    const blocked = path.join(root, 'not-directory');
    await fs.writeFile(blocked, 'file');
    const result = await readPdfPages(file, {
      pages: '1',
      render: 'always',
      outputDir: blocked,
      runtimeUrl,
    });
    expect(result.renderError).toBeDefined();
    expect(result.images).toEqual([]);
    expect(result.pages[0].text.length).toBeGreaterThan(0);
  });

  test('rejects oversized files before extraction', async () => {
    const root = tempDir();
    const file = path.join(root, 'large.pdf');
    await fs.writeFile(file, '');
    await fs.truncate(file, 51 * 1024 * 1024);
    await expect(readPdfPages(file, { runtimeUrl })).rejects.toThrow('50 MiB');
  });

  test('worker read uses the PDF branch and gateway attachment access is replaced each turn', async () => {
    const { root, file } = await fixture();
    const mediaRoot = tempDir();
    const attachment = path.join(mediaRoot, 'attachment.pdf');
    await fs.copyFile(file, attachment);
    await fs.symlink(path.resolve('skills'), path.join(root, 'skills'));
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
    vi.stubEnv('HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT', mediaRoot);
    const { executeToolWithMetadata, setMediaContext } = await import(
      '../container/src/tools.js'
    );
    setMediaContext([], ['/uploaded-media-cache/attachment.pdf']);
    const args = JSON.stringify({
      path: '/uploaded-media-cache/attachment.pdf',
      pages: '5-6',
      render: 'never',
    });
    const result = await executeToolWithMetadata('read', args);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).processedPages).toEqual([5, 6]);
    vi.resetModules();
    const restarted = await import('../container/src/tools.js');
    restarted.setMediaContext([], ['/uploaded-media-cache/attachment.pdf']);
    expect(
      (await restarted.executeToolWithMetadata('read', args)).isError,
    ).toBe(false);
    restarted.setMediaContext([]);
    expect(
      (await restarted.executeToolWithMetadata('read', args)).isError,
    ).toBe(true);
    setMediaContext([]);
    expect((await executeToolWithMetadata('read', args)).isError).toBe(true);
    expect(
      (
        await executeToolWithMetadata(
          'read',
          JSON.stringify({ path: file, offset: 1 }),
        )
      ).isError,
    ).toBe(true);
  });
});
