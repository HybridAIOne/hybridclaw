import fs from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { GATEWAY_DEBUG_MODEL_RESPONSES_ENV } from '../src/gateway/gateway-lifecycle.js';
import { consumeModelResponseDebugFileLine } from '../src/infra/model-response-debug.js';

const runtimeConfigMock = vi.hoisted(() => ({
  ops: { debugModelResponses: false },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

vi.mock('../src/config/config.js', () => ({
  DATA_DIR: '/tmp/hybridclaw-model-debug-test',
}));

vi.mock('../src/config/runtime-config.js', () => ({
  getRuntimeConfig: () => runtimeConfigMock,
}));

function encodeDebugLine(prefix: string, text: string): string {
  return `${prefix} ${Buffer.from(text, 'utf-8').toString('base64')}`;
}

describe('model response debug file consumer', () => {
  afterEach(() => {
    delete process.env[GATEWAY_DEBUG_MODEL_RESPONSES_ENV];
    runtimeConfigMock.ops.debugModelResponses = false;
    vi.clearAllMocks();
  });

  test('handles debug file markers without writing when model response debug is off', () => {
    vi.clearAllMocks();
    const modelResponseLine = encodeDebugLine(
      '[model-response-debug-file]',
      'data: first\n\n',
    );
    const lastPromptLine = encodeDebugLine(
      '[last-prompt-file]',
      '{"request":true}\n',
    );

    expect(consumeModelResponseDebugFileLine(modelResponseLine)).toBe(true);
    expect(consumeModelResponseDebugFileLine(lastPromptLine)).toBe(true);

    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.appendFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('ensures each debug output directory only once', () => {
    process.env[GATEWAY_DEBUG_MODEL_RESPONSES_ENV] = '1';
    vi.clearAllMocks();
    const modelResponseLine = encodeDebugLine(
      '[model-response-debug-file]',
      'data: first\n\n',
    );
    const lastPromptLine = encodeDebugLine(
      '[last-prompt-file]',
      '{"request":true}\n',
    );

    expect(consumeModelResponseDebugFileLine(modelResponseLine)).toBe(true);
    expect(consumeModelResponseDebugFileLine(modelResponseLine)).toBe(true);
    expect(consumeModelResponseDebugFileLine(lastPromptLine)).toBe(true);
    expect(consumeModelResponseDebugFileLine(lastPromptLine)).toBe(true);

    expect(fs.mkdirSync).toHaveBeenCalledTimes(2);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(2);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  test('writes debug output when enabled in runtime config', async () => {
    runtimeConfigMock.ops.debugModelResponses = true;
    vi.clearAllMocks();
    const modelResponseLine = encodeDebugLine(
      '[model-response-debug-file]',
      'data: config\n\n',
    );

    expect(consumeModelResponseDebugFileLine(modelResponseLine)).toBe(true);

    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });
});
