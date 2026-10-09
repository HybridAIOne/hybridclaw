import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { readPdfPages } from '../container/shared/pdf-reader.js';
import { useTempDir } from './test-utils.ts';

/**
 * The pdf skill in the agent image's layout: /workspace/node_modules links to
 * /app/node_modules (container/node_modules here) and the skill is mirrored
 * into /workspace/skills. pdfjs-dist resolves from the agent runtime, which
 * also has a different top-level @napi-rs/canvas; rendering must use the copy
 * pdfjs-dist loads itself, or drawing fails with "Value is none of these
 * types String, Path".
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const makeTempDir = useTempDir('hybridclaw-pdf-image-layout-');
const PDF_TEXT = 'Grüße aus Köln: 42 € — Łódź';

function agentWorkspace(): string {
  const workspace = makeTempDir();
  fs.symlinkSync(
    path.join(repoRoot, 'container', 'node_modules'),
    path.join(workspace, 'node_modules'),
    'dir',
  );
  fs.cpSync(
    path.join(repoRoot, 'skills', 'pdf'),
    path.join(workspace, 'skills', 'pdf'),
    { recursive: true },
  );
  return workspace;
}

function runScript(workspace: string, script: string, args: string[]) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  const result = spawnSync(
    process.execPath,
    [path.join('skills', 'pdf', 'scripts', script), ...args],
    { cwd: workspace, encoding: 'utf8', env },
  );
  expect(result.status, `${script}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

test('bundled pdf scripts create, extract and render in the agent image layout', () => {
  const workspace = agentWorkspace();
  runScript(workspace, 'create_pdf.mjs', ['report.pdf', '--text', PDF_TEXT]);
  expect(runScript(workspace, 'extract_pdf_text.mjs', ['report.pdf'])).toContain(
    PDF_TEXT,
  );
  runScript(workspace, 'render_pdf_pages.mjs', ['report.pdf', 'pages']);
  const png = fs.readFileSync(path.join(workspace, 'pages', 'page_1.png'));
  expect(png.subarray(1, 4).toString()).toBe('PNG');
});

test('without the agent runtime, rendering reports the canvas requirement', async () => {
  const skillDir = path.join(makeTempDir(), 'skills', 'pdf');
  fs.cpSync(path.join(repoRoot, 'skills', 'pdf'), skillDir, {
    recursive: true,
  });
  const runtime = await import(
    pathToFileURL(path.join(skillDir, 'scripts', '_pdf_runtime.mjs')).href
  );

  await expect(runtime.loadCanvas()).rejects.toThrow(
    /@napi-rs\/canvas is required for PDF rendering/,
  );
});

test('the read tool path renders pages through the workspace pdf runtime', async () => {
  const workspace = agentWorkspace();
  runScript(workspace, 'create_pdf.mjs', ['report.pdf', '--text', PDF_TEXT]);

  const result = await readPdfPages(path.join(workspace, 'report.pdf'), {
    render: 'always',
    outputDir: makeTempDir(),
    runtimeUrl: pathToFileURL(
      path.join(workspace, 'skills', 'pdf', 'scripts', '_pdf_runtime.mjs'),
    ).href,
  });

  expect(result.renderError).toBeUndefined();
  expect(result.pages[0].text).toContain(PDF_TEXT);
  expect(result.images.map((image) => image.page)).toEqual([1]);
});
