import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  discoverArtifactsSince,
  inferArtifactMimeType,
} from '../container/src/artifacts.js';

test('infers OOXML artifact mime types', () => {
  expect(inferArtifactMimeType('report.docx')).toBe(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  expect(inferArtifactMimeType('deck.pptx')).toBe(
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );
  expect(inferArtifactMimeType('model.xlsx')).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  expect(inferArtifactMimeType('preview.png')).toBe('image/png');
  expect(inferArtifactMimeType('voiceover.mp3')).toBe('audio/mpeg');
  expect(inferArtifactMimeType('diagram.mmd')).toBe('text/vnd.mermaid');
});

test('discovers recently created artifact files under the workspace root', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-artifacts-'),
  );
  try {
    const createdAtMs = Date.now();
    const workbookPath = path.join(tempDir, 'profit-summary.xlsx');
    const sourcePath = path.join(tempDir, 'profit-summary.cjs');
    fs.writeFileSync(workbookPath, 'xlsx payload');
    fs.writeFileSync(sourcePath, 'console.log("helper");');

    const artifacts = discoverArtifactsSince(tempDir, {
      modifiedAfterMs: createdAtMs - 1_000,
    });

    expect(artifacts).toEqual([
      {
        path: workbookPath,
        filename: 'profit-summary.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
