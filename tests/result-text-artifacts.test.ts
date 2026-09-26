import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { recoverGeneratedMediaArtifactsFromResultText } from '../src/gateway/result-text-artifacts.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-generated-artifacts-');

describe('generated media artifact recovery', () => {
  test('recovers web-visible artifact metadata from generated video text paths', () => {
    const workspacePath = makeTempDir();
    const outputDir = path.join(workspacePath, '.generated-videos');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'demo.mp4'), 'mp4');

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        resultText:
          'Here is the artifact: `.generated-videos/demo.mp4`. It should render.',
      }),
    ).toEqual([
      {
        path: path.join(outputDir, 'demo.mp4'),
        filename: 'demo.mp4',
        mimeType: 'video/mp4',
      },
    ]);
  });

  test('recovers generated image artifacts from encoded artifact routes', () => {
    const workspacePath = makeTempDir();
    const outputDir = path.join(workspacePath, '.generated-images');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'render.png'), 'png');

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        resultText:
          '/api/artifact?path=.generated-images%2Frender.png should render.',
      }),
    ).toEqual([
      {
        path: path.join(outputDir, 'render.png'),
        filename: 'render.png',
        mimeType: 'image/png',
      },
    ]);
  });

  test('preserves existing artifacts and ignores missing generated files', () => {
    const workspacePath = makeTempDir();
    const existing = {
      path: path.join(workspacePath, 'report.pdf'),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    };

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        artifacts: [existing],
        resultText: '.generated-videos/missing.mp4',
      }),
    ).toEqual([existing]);
  });

  test('recovers a referenced PDF from the workspace root', () => {
    const workspacePath = makeTempDir();
    const pdfPath = path.join(workspacePath, 'dog_with_image.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.7');

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        resultText:
          'Erledigt: [dog_with_image.pdf](sandbox:/workspace/dog_with_image.pdf)',
      }),
    ).toEqual([
      {
        path: pdfPath,
        filename: 'dog_with_image.pdf',
        mimeType: 'application/pdf',
      },
    ]);
  });

  test('recovers a referenced Office artifact from a nested workspace path', () => {
    const workspacePath = makeTempDir();
    const outputDir = path.join(workspacePath, 'outputs');
    fs.mkdirSync(outputDir);
    const documentPath = path.join(outputDir, 'Überblick.docx');
    fs.writeFileSync(documentPath, 'docx');

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        resultText: 'The document is `outputs/Überblick.docx`.',
      }),
    ).toEqual([
      {
        path: documentPath,
        filename: 'Überblick.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ]);
  });

  test('recovers generated media artifacts without replacing assistant text', () => {
    const workspacePath = makeTempDir();
    const outputDir = path.join(workspacePath, '.generated-videos');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'demo.mp4'), 'mp4');
    const resultText =
      "Here's the video: `.generated-videos/demo.mp4`. It is attached below.";

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        resultText,
      }),
    ).toEqual([
      {
        path: path.join(outputDir, 'demo.mp4'),
        filename: 'demo.mp4',
        mimeType: 'video/mp4',
      },
    ]);
    expect(resultText).toContain('It is attached below.');
  });

  test('keeps generated media artifacts mentioned in assistant text', () => {
    const workspacePath = makeTempDir();
    const outputDir = path.join(workspacePath, '.generated-videos');
    fs.mkdirSync(outputDir, { recursive: true });
    const videoBytes = Buffer.from('same-rendered-video');
    const rawFilename = '36bff5a782824f379299ce71326e781b-1778920169468.mp4';
    const friendlyFilename = 'hybridclaw-erklarung-de-benedikt.mp4';
    const rawPath = path.join(outputDir, rawFilename);
    const friendlyPath = path.join(outputDir, friendlyFilename);
    fs.writeFileSync(rawPath, videoBytes);
    fs.writeFileSync(friendlyPath, videoBytes);

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        artifacts: [
          {
            path: rawPath,
            filename: rawFilename,
            mimeType: 'video/mp4',
          },
          {
            path: friendlyPath,
            filename: friendlyFilename,
            mimeType: 'video/mp4',
          },
        ],
        resultText: `The generated video is ${friendlyFilename}.`,
      }),
    ).toEqual([
      {
        path: friendlyPath,
        filename: friendlyFilename,
        mimeType: 'video/mp4',
      },
    ]);
  });

  test.each([
    {
      name: 'host workspace path behind a sandbox: link',
      link: (workspacePath: string) =>
        `sandbox:${workspacePath}/prospects/list.md`,
    },
    {
      name: 'file:// link to the host workspace',
      link: (workspacePath: string) =>
        `file://${workspacePath}/prospects/list.md`,
    },
    { name: 'container workspace path', link: () => '/workspace/prospects/list.md' },
    { name: 'relative path', link: () => 'prospects/list.md' },
  ])('recovers a linked markdown document from a $name', ({ link }) => {
    const workspacePath = makeTempDir();
    fs.mkdirSync(path.join(workspacePath, 'prospects'));
    const documentPath = path.join(workspacePath, 'prospects', 'list.md');
    fs.writeFileSync(documentPath, '# Prospects');

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        resultText: `Ich habe die [Prospektliste](${link(workspacePath)}) erstellt.`,
      }),
    ).toEqual([
      { path: documentPath, filename: 'list.md', mimeType: 'text/markdown' },
    ]);
  });

  test('recovers a host-path PDF mention outside a link', () => {
    const workspacePath = makeTempDir();
    const pdfPath = path.join(workspacePath, 'report.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.7');

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        resultText: `Saved to ${workspacePath}/report.pdf.`,
      }),
    ).toEqual([
      { path: pdfPath, filename: 'report.pdf', mimeType: 'application/pdf' },
    ]);
  });

  test.each([
    { name: 'mentioned without a link', text: () => 'I updated MEMORY.md.' },
    {
      name: 'linked outside the workspace',
      text: () => '[notes](sandbox:/etc/MEMORY.md)',
    },
    {
      name: 'linked through a parent segment',
      text: () => '[notes](../MEMORY.md)',
    },
  ])('ignores a text document $name', ({ text }) => {
    const workspacePath = makeTempDir();
    fs.writeFileSync(path.join(workspacePath, 'MEMORY.md'), '# Memory');

    expect(
      recoverGeneratedMediaArtifactsFromResultText({
        workspacePath,
        resultText: text(),
      }),
    ).toBeUndefined();
  });

  describe('documents written this turn', () => {
    const writeCall = (filePath: string, isError = false) => ({
      name: 'write',
      arguments: JSON.stringify({ path: filePath, contents: 'x' }),
      result: isError ? 'Error' : 'Wrote 1 bytes',
      durationMs: 1,
      isError,
    });

    test('attaches a host-path write that the reply names without a usable link', () => {
      const workspacePath = makeTempDir();
      const documentPath = path.join(workspacePath, 'prospects.md');
      fs.writeFileSync(documentPath, '# Prospects');

      expect(
        recoverGeneratedMediaArtifactsFromResultText({
          workspacePath,
          toolExecutions: [writeCall(documentPath)],
          resultText: 'Die Liste steht in prospects.md.',
        }),
      ).toEqual([
        {
          path: documentPath,
          filename: 'prospects.md',
          mimeType: 'text/markdown',
        },
      ]);
    });

    test.each([
      {
        name: 'the reply does not name it',
        written: 'list.csv',
        text: 'Fertig.',
      },
      {
        name: 'the reply names only a longer filename',
        written: 'list.csv',
        text: 'See checklist.csv.',
      },
      {
        name: 'the reply names only a longer extension',
        written: 'list.md',
        text: 'The list.mdx export and list.md5 checksum are ready.',
      },
      {
        name: 'the reply names only a backup copy',
        written: 'list.md',
        text: 'Restored from list.md.bak.',
      },
      {
        name: 'it is a bootstrap file',
        written: 'MEMORY.md',
        text: 'I updated MEMORY.md.',
      },
      {
        name: 'it is a daily memory note',
        written: 'memory/2026-09-25.md',
        text: 'Noted in 2026-09-25.md.',
      },
      {
        name: 'it is source code',
        written: 'app.ts',
        text: 'I changed app.ts.',
      },
      {
        name: 'the write failed',
        written: 'list.csv',
        text: 'See list.csv.',
        isError: true,
      },
    ])('does not attach a write when $name', ({ written, text, isError }) => {
      const workspacePath = makeTempDir();
      const filePath = path.join(workspacePath, written);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'x');

      expect(
        recoverGeneratedMediaArtifactsFromResultText({
          workspacePath,
          toolExecutions: [writeCall(written, isError)],
          resultText: text,
        }),
      ).toBeUndefined();
    });
  });
});
