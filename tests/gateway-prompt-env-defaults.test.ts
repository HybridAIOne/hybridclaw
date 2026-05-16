import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildEmptyAgentResponseFallback,
  recoverGeneratedMediaArtifactsFromResultText,
  validateGatewayPromptEnvDefaults,
} from '../src/gateway/gateway-chat-service.js';
import {
  GATEWAY_SYSTEM_PROMPT_MODE_ENV,
  GATEWAY_SYSTEM_PROMPT_PARTS_ENV,
  GATEWAY_TOOLS_MODE_ENV,
} from '../src/gateway/gateway-lifecycle.js';

const ENV_NAMES = [
  GATEWAY_SYSTEM_PROMPT_MODE_ENV,
  GATEWAY_SYSTEM_PROMPT_PARTS_ENV,
  GATEWAY_TOOLS_MODE_ENV,
];
const tempDirs: string[] = [];

describe('gateway prompt env defaults', () => {
  afterEach(() => {
    for (const envName of ENV_NAMES) {
      delete process.env[envName];
    }
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('accepts valid gateway prompt and tools defaults', () => {
    process.env[GATEWAY_SYSTEM_PROMPT_MODE_ENV] = 'minimal';
    process.env[GATEWAY_SYSTEM_PROMPT_PARTS_ENV] = 'soul,memory-file';
    process.env[GATEWAY_TOOLS_MODE_ENV] = 'none';

    expect(() => validateGatewayPromptEnvDefaults()).not.toThrow();
  });

  test('throws on invalid gateway system prompt mode default', () => {
    process.env[GATEWAY_SYSTEM_PROMPT_MODE_ENV] = 'minmal';

    expect(() => validateGatewayPromptEnvDefaults()).toThrow(
      /Invalid value for HYBRIDCLAW_SYSTEM_PROMPT_MODE: minmal/,
    );
  });

  test('throws on invalid gateway tools mode default', () => {
    process.env[GATEWAY_TOOLS_MODE_ENV] = 'disabled';

    expect(() => validateGatewayPromptEnvDefaults()).toThrow(
      /Invalid value for HYBRIDCLAW_TOOLS_MODE: disabled/,
    );
  });

  test('throws on invalid gateway prompt part defaults', () => {
    process.env[GATEWAY_SYSTEM_PROMPT_PARTS_ENV] = 'soul,bogus';

    expect(() => validateGatewayPromptEnvDefaults()).toThrow(
      /Invalid value for HYBRIDCLAW_SYSTEM_PROMPT_PARTS: Unknown prompt part/,
    );
  });
});

describe('generated media artifact recovery', () => {
  test('recovers web-visible artifact metadata from generated video text paths', () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-generated-artifacts-'),
    );
    tempDirs.push(workspacePath);
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
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-generated-artifacts-'),
    );
    tempDirs.push(workspacePath);
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
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-generated-artifacts-'),
    );
    tempDirs.push(workspacePath);
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

  test('recovers generated media artifacts without replacing assistant text', () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-generated-artifacts-'),
    );
    tempDirs.push(workspacePath);
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
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-generated-artifacts-'),
    );
    tempDirs.push(workspacePath);
    const outputDir = path.join(workspacePath, '.generated-videos');
    fs.mkdirSync(outputDir, { recursive: true });
    const videoBytes = Buffer.from('same-rendered-video');
    const rawFilename =
      '36bff5a782824f379299ce71326e781b-1778920169468.mp4';
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
});

describe('empty agent response fallback', () => {
  test('allows empty assistant text when artifacts are attached', () => {
    expect(
      buildEmptyAgentResponseFallback([
        {
          path: '/tmp/hybridclaw_io.png',
          filename: 'hybridclaw_io.png',
          mimeType: 'image/png',
        },
      ]),
    ).toBe('');
  });

  test('keeps the legacy fallback when there are no artifacts', () => {
    expect(buildEmptyAgentResponseFallback()).toBe('No response from agent.');
  });
});
