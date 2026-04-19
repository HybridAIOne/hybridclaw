import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { remapOutputArtifacts } from '../src/infra/container-runner.js';
import type { ContainerOutput } from '../src/types/container.js';

test('remaps artifact paths that use a custom workspace display root', () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-artifact-remap-'),
  );
  try {
    const output: ContainerOutput = {
      status: 'success',
      result: 'ok',
      toolsUsed: [],
      artifacts: [
        {
          path: '/app/output.pdf',
          filename: 'output.pdf',
          mimeType: 'application/pdf',
        },
      ],
    };

    remapOutputArtifacts(output, workspacePath, '/app');

    expect(output.artifacts).toEqual([
      {
        path: path.join(workspacePath, 'output.pdf'),
        filename: 'output.pdf',
        mimeType: 'application/pdf',
      },
    ]);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
