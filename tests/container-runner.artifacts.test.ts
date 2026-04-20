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

test('prefers the longest matching workspace display root when remapping', () => {
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
          path: '/workspace/sub/output.pdf',
          filename: 'output.pdf',
          mimeType: 'application/pdf',
        },
      ],
    };

    remapOutputArtifacts(output, workspacePath, '/workspace/sub');

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

test('preserves host artifact paths when the real workspace already lives under /workspace', () => {
  // No filesystem setup is needed here because remapOutputArtifacts only
  // normalizes and resolves the path string; it does not stat the workspace.
  const workspacePath = '/workspace/.data/data/agents/main/workspace';
  const output: ContainerOutput = {
    status: 'success',
    result: 'ok',
    toolsUsed: [],
    artifacts: [
      {
        path: '/workspace/.data/data/agents/main/workspace/output.pdf',
        filename: 'output.pdf',
        mimeType: 'application/pdf',
      },
    ],
  };

  remapOutputArtifacts(output, workspacePath);

  expect(output.artifacts).toEqual([
    {
      path: '/workspace/.data/data/agents/main/workspace/output.pdf',
      filename: 'output.pdf',
      mimeType: 'application/pdf',
    },
  ]);
});
