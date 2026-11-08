import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
  test('a fatal renderer exit preserves text and lets the reader serve the next call', async () => {
    const { root, file } = await fixture();
    const runtime = path.join(root, '_pdf_runtime.mjs');
    await fs.writeFile(runtime, [
      `export { extractPdfText, subsetPdfBytes } from ${JSON.stringify(runtimeUrl)};`,
      `import { renderPdfPages as render } from ${JSON.stringify(runtimeUrl)};`,
      `export async function renderPdfPages(params) {
        if (params.pageNumbers === '1') process.kill(process.pid, 'SIGKILL');
        if (params.pageNumbers.includes(',')) process.kill(process.pid, 'SIGSEGV');
        return render(params);
      }`,
    ].join('\n'));
    await fs.copyFile(path.resolve('skills/pdf/scripts/render_pdf_pages.mjs'), path.join(root, 'render_pdf_pages.mjs'));
    const reader = pathToFileURL(path.resolve('container/shared/pdf-reader.js')).href;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readPdfPages } from ${JSON.stringify(reader)};
      const options = { runtimeUrl: ${JSON.stringify(pathToFileURL(runtime).href)}, outputDir: ${JSON.stringify(root)}, workspaceRoot: ${JSON.stringify(root)}, pages: '1' };
      const run = render => readPdfPages(${JSON.stringify(file)}, { ...options, render });
      const first = await run('always');
      const next = await run('never');
      const recovered = await readPdfPages(${JSON.stringify(file)}, { ...options, render: 'always', pages: '3,5' });
      console.log(JSON.stringify({first, next, recovered}));
    `], { encoding: 'utf8', timeout: 15000 });
    expect(probe.status, probe.signal || probe.stderr).toBe(0);
    const { first, next, recovered } = JSON.parse(probe.stdout);
    expect(first.images).toEqual([]);
    expect(first.renderError).toContain('SIGKILL');
    expect(first.pages[0].text).toContain('Readable document evidence');
    expect(first.visualAttachments).toEqual([expect.objectContaining({ pages: [1] })]);
    expect(next.pages[0].text).toBe(first.pages[0].text);
    expect(next.renderError).toBeUndefined();
    expect(recovered.renderError).toBeUndefined();
    expect(recovered.images.map((image: { page: number }) => image.page)).toEqual([3, 5]);
    expect(recovered.visualAttachments).toEqual([expect.objectContaining({ pages: [3, 5] })]);
  });

  test('a renderer exits if its reader disappears during a render', async () => {
    const root = tempDir();
    const entry = path.join(root, 'render_pdf_pages.mjs');
    await fs.copyFile(path.resolve('skills/pdf/scripts/render_pdf_pages.mjs'), entry);
    await fs.writeFile(path.join(root, '_pdf_runtime.mjs'), [
      'export function renderPdfPages() {',
      "  process.send('started');",
      '  return new Promise(() => setInterval(() => {}, 60_000));',
      '}',
    ].join('\n'));
    const child = fork(entry, ['--render-for-read', '{}'], {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const terminated = once(child, 'exit');
    try {
      const signal = AbortSignal.timeout(3_000);
      const [started] = await once(child, 'message', { signal });
      expect(started).toBe('started');
      const exited = once(child, 'exit', { signal });
      child.disconnect();
      expect(await exited).toEqual([1, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await terminated;
    }
  });

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

  test.each([
    { pages: '2-6', lineArgs: { limit: 1 }, expected: [2, 3, 4, 5] },
    { pages: '5-6', lineArgs: { limit: 20 }, expected: [5, 6] },
    { pages: '6,2,2,4,3,5', lineArgs: { offset: 9 }, expected: [2, 3, 4, 6] },
    { pages: '2-9999999999', lineArgs: {}, expected: [2, 3, 4, 5] },
  ])('offers an executable first batch for $pages with $lineArgs', async ({
    pages,
    lineArgs,
    expected,
  }) => {
    const { root } = await fixture();
    await fs.symlink(path.resolve('skills'), path.join(root, 'skills'));
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const args = { path: 'document.pdf', pages, render: 'never', ...lineArgs };
    const failed = await executeToolWithMetadata('read', JSON.stringify(args));
    expect(failed.isError).toBe(true);
    expect(failed.visualAttachments).toBeUndefined();
    const { suggestedCall } = JSON.parse(failed.output);
    expect(suggestedCall.name).toBe('read');
    expect(suggestedCall.arguments).toEqual({
      path: args.path,
      pages: expected.join(','),
      render: args.render,
    });
    const retry = await executeToolWithMetadata(
      suggestedCall.name,
      JSON.stringify(suggestedCall.arguments),
    );
    expect(retry.isError).toBe(false);
    expect(JSON.parse(retry.output)).toMatchObject({
      processedPages: expected,
      omittedPages: 6 - expected.length,
    });
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
