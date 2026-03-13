import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  detectToolCallLoop,
  recordToolCallOutcome,
} from '../container/src/tool-loop-detection.js';

describe.sequential('container tool runtime guards', () => {
  let workspaceRoot = '';
  let tempImagePath = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
    if (tempImagePath) {
      fs.rmSync(tempImagePath, { force: true });
      tempImagePath = '';
    }
  });

  test('keeps read output with error-like words as a successful tool result', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-tool-guards-'),
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'notes.md'),
      'Formula Error Prevention\ninvalid references are bad examples.\n',
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'read',
      JSON.stringify({ path: 'notes.md' }),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Formula Error Prevention');
  });

  test('marks explicit tool failures structurally', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-tool-guards-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'read',
      JSON.stringify({ path: 'missing.md' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('File not found');
  });

  test('vision_analyze supports vllm without apiKey or chatbotId', async () => {
    tempImagePath = path.join(
      os.tmpdir(),
      `hybridclaw-vision-${Date.now()}.jpg`,
    );
    fs.writeFileSync(tempImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Detected test image.',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { executeToolWithMetadata, setModelContext } = await import(
      '../container/src/tools.js'
    );
    setModelContext(
      'vllm',
      'http://haigpu1:8000/v1',
      '',
      'vllm/Qwen/Qwen3.5-27B-FP8',
      '',
    );

    const result = await executeToolWithMetadata(
      'vision_analyze',
      JSON.stringify({
        image_url: tempImagePath,
        question: 'What is in this image?',
      }),
    );

    expect(result.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://haigpu1:8000/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.not.objectContaining({
          Authorization: expect.any(String),
        }),
      }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      model: 'Qwen/Qwen3.5-27B-FP8',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image_url',
              image_url: expect.objectContaining({
                url: expect.stringMatching(/^data:image\/jpeg;base64,/),
              }),
            },
          ],
        },
      ],
    });
    expect(result.output).toContain('"success": true');
    expect(result.output).toContain('Detected test image.');
  });

  test('vision_analyze uses Ollama native vision requests', async () => {
    tempImagePath = path.join(
      os.tmpdir(),
      `hybridclaw-vision-${Date.now()}.png`,
    );
    fs.writeFileSync(tempImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: {
              content: 'Detected test image via Ollama.',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { executeToolWithMetadata, setModelContext } = await import(
      '../container/src/tools.js'
    );
    setModelContext(
      'ollama',
      'http://127.0.0.1:11434/v1',
      '',
      'ollama/llava:7b',
      '',
    );

    const result = await executeToolWithMetadata(
      'vision_analyze',
      JSON.stringify({
        image_url: tempImagePath,
        question: 'What is in this image?',
      }),
    );

    expect(result.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      model: 'llava:7b',
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'What is in this image?',
          images: [expect.any(String)],
        },
      ],
    });
    expect(requestBody.messages[0].images[0]).not.toMatch(/^data:/);
    expect(result.output).toContain('Detected test image via Ollama.');
  });

  test('vision_analyze adds /v1 for lmstudio base URLs without a version suffix', async () => {
    tempImagePath = path.join(
      os.tmpdir(),
      `hybridclaw-vision-${Date.now()}.jpg`,
    );
    fs.writeFileSync(tempImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Detected test image via LM Studio.',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { executeToolWithMetadata, setModelContext } = await import(
      '../container/src/tools.js'
    );
    setModelContext(
      'lmstudio',
      'http://127.0.0.1:1234',
      '',
      'lmstudio/qwen/qwen2.5-vl',
      '',
    );

    const result = await executeToolWithMetadata(
      'vision_analyze',
      JSON.stringify({
        image_url: tempImagePath,
        question: 'What is in this image?',
      }),
    );

    expect(result.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(result.output).toContain('Detected test image via LM Studio.');
  });

  test('vision_analyze prefers the configured vision task model policy', async () => {
    tempImagePath = path.join(
      os.tmpdir(),
      `hybridclaw-vision-${Date.now()}.jpg`,
    );
    fs.writeFileSync(tempImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Detected via task model policy.',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { executeToolWithMetadata, setModelContext, setTaskModelPolicies } =
      await import('../container/src/tools.js');
    setModelContext(
      'hybridai',
      'https://hybridai.one',
      'main-model-key',
      'gpt-5-nano',
      'bot_123',
    );
    setTaskModelPolicies({
      vision: {
        provider: 'lmstudio',
        baseUrl: 'http://127.0.0.1:1234',
        apiKey: '',
        model: 'lmstudio/qwen/qwen2.5-vl',
        chatbotId: '',
        requestHeaders: {},
        isLocal: true,
        maxTokens: 321,
      },
    });

    const result = await executeToolWithMetadata(
      'vision_analyze',
      JSON.stringify({
        image_url: tempImagePath,
        question: 'What is in this image?',
      }),
    );

    expect(result.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      model: 'qwen/qwen2.5-vl',
      max_tokens: 321,
    });
    expect(result.output).toContain('Detected via task model policy.');
  });

  test('blocks repeated identical discovery calls with identical outcomes', () => {
    const history = [];
    const argsJson = JSON.stringify({ path: 'same.md' });

    for (let i = 0; i < 3; i += 1) {
      recordToolCallOutcome(history, 'read', argsJson, 'same output', false);
    }

    const result = detectToolCallLoop(history, 'read', argsJson);

    expect(result.stuck).toBe(true);
    if (!result.stuck) return;
    expect(result.detector).toBe('generic_repeat');
    expect(result.count).toBe(4);
  });

  test('blocks repeated ping-pong discovery loops with no new information', () => {
    const history = [];
    const readArgs = JSON.stringify({ path: 'a.md' });
    const globArgs = JSON.stringify({ pattern: '*.md' });

    recordToolCallOutcome(history, 'read', readArgs, 'same read', false);
    recordToolCallOutcome(history, 'glob', globArgs, 'same glob', false);
    recordToolCallOutcome(history, 'read', readArgs, 'same read', false);
    recordToolCallOutcome(history, 'glob', globArgs, 'same glob', false);
    recordToolCallOutcome(history, 'read', readArgs, 'same read', false);

    const result = detectToolCallLoop(history, 'glob', globArgs);

    expect(result.stuck).toBe(true);
    if (!result.stuck) return;
    expect(result.detector).toBe('ping_pong');
    expect(result.count).toBe(6);
  });
});
