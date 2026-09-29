import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, test, vi } from 'vitest';
import {
  loadVisualSnapshot,
  saveVisualSnapshot,
  validateVisualAttachments,
} from '../container/shared/visual-snapshots.js';
import { readPdfPages } from '../container/shared/pdf-reader.js';
import { validateToolHistory } from '../container/shared/tool-history.js';
import type { ChatMessage } from '../container/src/types.js';
import { injectPdfContextMessages } from '../src/media/pdf-context.js';
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
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  const pdf = await PDFDocument.create();
  for (let i = 1; i <= 5; i++)
    pdf.addPage([100, 100]).drawText(`Page ${i}`, { x: 5, y: 30, size: 10 });
  const file = path.join(root, 'document.pdf');
  await fs.writeFile(file, await pdf.save());
  await fs.symlink(path.resolve('skills'), path.join(root, 'skills'));
  const result = await readPdfPages(file, {
    pages: '2,4',
    render: 'auto',
    workspaceRoot: root,
    outputDir: path.join(root, 'rendered'),
    runtimeUrl,
  });
  expect(result.visualAttachments).toHaveLength(1);
  return { root, file, ref: result.visualAttachments![0] };
}
function response(provider: string) {
  const payload =
    provider === 'anthropic'
      ? {
          id: 'msg_test',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
        }
      : provider === 'openai' || provider === 'openai-codex'
        ? {
            id: 'resp_test',
            model: 'gpt-5',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
          }
        : {
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          };
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}
const base = { apiKey: 'test-key', chatbotId: '', tools: [], maxTokens: 128 };

describe('direct PDF delivery', () => {
  test.each([
    ['openai', 'https://api.openai.com/v1', 'gpt-4.1-mini', 'input_image'],
    ['anthropic', 'https://api.anthropic.com/v1', 'claude-haiku-4-5', 'image'],
    [
      'openai-codex',
      'https://chatgpt.com/backend-api/codex',
      'gpt-5.4',
      'input_image',
    ],
  ] as const)(
    'standalone read pixels use %s native image content',
    async (provider, baseUrl, model, partType) => {
      const { root, ref } = await fixture();
      const snapshot = await loadVisualSnapshot(root, ref);
      const image = await saveVisualSnapshot(
        root,
        { pdf: '', images: [snapshot.images[0]] },
        [],
      );
      const { setVisualMediaAllowed } = await import(
        '../container/src/providers/visual-content.js'
      );
      setVisualMediaAllowed(true);
      const { callRoutedModel } = await import(
        '../container/src/providers/router.js'
      );
      const requests: Record<string, unknown>[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(String(init.body)));
          return response(provider);
        }),
      );
      await callRoutedModel({
        ...base,
        provider,
        baseUrl,
        model,
        messages: [
          {
            role: 'user',
            content: 'Describe this image',
            visualAttachments: [image],
          },
        ],
      });
      expect(requests).toHaveLength(1);
      const wire = JSON.stringify(requests[0]);
      expect(wire).toContain(`"type":"${partType}"`);
      expect(wire).toContain(snapshot.images[0]);
      expect(wire).not.toContain('visualAttachments');
      expect(wire).not.toContain('input_file');
      expect(wire).not.toContain('"type":"document"');
    },
  );
  test.each([
    ['openai', 'https://api.openai.com/v1', 'gpt-5', 'input_file'],
    [
      'anthropic',
      'https://api.anthropic.com/v1',
      'claude-sonnet-4-6',
      'document',
    ],
    ['vllm', 'http://127.0.0.1:8000/v1', 'qwen3.8-27b', 'image_url'],
    [
      'gemini',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'gemini-2.5-pro',
      'image_url',
    ],
    ['openai', 'https://example.com/v1', 'gpt-5', 'input_image'],
    [
      'openai-codex',
      'https://chatgpt.com/backend-api/codex',
      'gpt-5.4',
      'input_image',
    ],
  ] as const)(
    'sends selected pages to %s as %s',
    async (provider, baseUrl, model, partType) => {
      const { root, ref } = await fixture();
      const snapshot = await loadVisualSnapshot(root, ref);
      expect(
        (
          await PDFDocument.load(Buffer.from(snapshot.pdf, 'base64'))
        ).getPageCount(),
      ).toBe(2);
      expect(snapshot.images).toHaveLength(2);
      const { setVisualMediaAllowed } = await import(
        '../container/src/providers/visual-content.js'
      );
      setVisualMediaAllowed(true);
      const { callRoutedModel } = await import(
        '../container/src/providers/router.js'
      );
      const calls: Record<string, unknown>[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          calls.push(JSON.parse(String(init.body)));
          return response(provider);
        }),
      );
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Read these pages', visualAttachments: [ref] },
      ];
      const before = structuredClone(messages);
      await callRoutedModel({ ...base, provider, baseUrl, model, messages });
      const wire = JSON.stringify(calls[0]);
      expect(wire).toContain(`"type":"${partType}"`);
      expect(wire).not.toContain('visualAttachments');
      expect(wire).toContain('original pages 2, 4');
      expect(messages).toEqual(before);
      expect(calls).toHaveLength(1);
    },
  );

  test('read results replay after worker replacement and keep parallel tool results paired', async () => {
    const { file } = await fixture();
    const tools = await import('../container/src/tools.js');
    const result = await tools.executeToolWithMetadata(
      'read',
      JSON.stringify({ path: file, pages: '2,4' }),
    );
    expect(result.isError).toBe(false);
    expect(result.visualAttachments).toHaveLength(1);
    expect(result.output).not.toContain('base64');
    const history = validateToolHistory([
      {
        role: 'assistant',
        content: null,
        tool_calls: ['a', 'b'].map((id) => ({
          id,
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        })),
      },
      {
        role: 'tool',
        tool_call_id: 'a',
        content: result.output,
        visualAttachments: result.visualAttachments,
      },
      { role: 'tool', tool_call_id: 'b', content: 'Other result' },
    ]);
    vi.resetModules();
    const { setVisualMediaAllowed } = await import(
      '../container/src/providers/visual-content.js'
    );
    setVisualMediaAllowed(true);
    const { callRoutedModel } = await import(
      '../container/src/providers/router.js'
    );
    const fetchMock = vi.fn(async (_url, init) => {
      const wire = JSON.parse(String(init.body));
      expect(wire.messages.map((m: ChatMessage) => m.role)).toEqual([
        'assistant',
        'tool',
        'tool',
        'user',
      ]);
      expect(
        wire.messages[3].content.filter(
          (p: { type: string }) => p.type === 'image_url',
        ),
      ).toHaveLength(2);
      return response('vllm');
    });
    vi.stubGlobal('fetch', fetchMock);
    await callRoutedModel({
      ...base,
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'qwen3.8-27b',
      messages: history,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('automatic previews attach visuals without modifying the source messages', async () => {
    const { root, file } = await fixture();
    const messages: ChatMessage[] = [
      { role: 'user', content: `Read "${file}"` },
    ];
    const preview = await injectPdfContextMessages({
      messages,
      workspaceRoot: root,
      visualMediaAllowed: true,
    });
    expect(preview[0].visualAttachments?.[0].pages).toEqual([1, 2, 3, 4]);
    expect(messages[0].visualAttachments).toBeUndefined();
  });

  test('retries explicit native rejection as images, then reports text-only coverage', async () => {
    const { ref } = await fixture();
    const { setVisualMediaAllowed } = await import(
      '../container/src/providers/visual-content.js'
    );
    setVisualMediaAllowed(true);
    const { callRoutedModelStream } = await import(
      '../container/src/providers/router.js'
    );
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        bodies.push(String(init.body));
        if (bodies.length < 3)
          return new Response(
            JSON.stringify({
              error: {
                message:
                  bodies.length === 1
                    ? 'Unsupported PDF input_file'
                    : 'Model does not support image input',
              },
            }),
            { status: 400 },
          );
        return response('openai');
      }),
    );
    const delta = vi.fn();
    await callRoutedModelStream({
      ...base,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'read', visualAttachments: [ref] }],
      onTextDelta: delta,
    });
    expect(bodies[0]).toContain('input_file');
    expect(bodies[1]).toContain('input_image');
    expect(bodies[2]).not.toContain('base64');
    expect(bodies[2]).toContain('Visual content not sent');
    expect(delta.mock.calls.flat()).toEqual(['ok']);
  });

  test.each([401, 429, 500])(
    'does not downgrade on unrelated HTTP %s errors',
    async (status) => {
      const { ref } = await fixture();
      const { setVisualMediaAllowed } = await import(
        '../container/src/providers/visual-content.js'
      );
      setVisualMediaAllowed(true);
      const { callRoutedModel } = await import(
        '../container/src/providers/router.js'
      );
      const fetchMock = vi.fn(
        async () => new Response('PDF input unavailable', { status }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        callRoutedModel({
          ...base,
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5',
          messages: [
            { role: 'user', content: 'read', visualAttachments: [ref] },
          ],
        }),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test('disallowed binary replay emits a coverage warning without reading the snapshot', async () => {
    const { ref, root } = await fixture();
    await fs.rm(path.join(root, '.visual-snapshots'), { recursive: true });
    const { callRoutedModel } = await import(
      '../container/src/providers/router.js'
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const wire = String(init.body);
        expect(wire).not.toContain('base64');
        expect(wire).toContain('Visual content not sent');
        return response('openai');
      }),
    );
    await callRoutedModel({
      ...base,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'read', visualAttachments: [ref] }],
    });
  });
});

describe('PDF snapshot boundaries', () => {
  test.each([
    [{ id: '../secret', pages: [1] }],
    [{ id: 'a'.repeat(64), pages: [0] }],
    [{ id: 'a'.repeat(64), pages: [1, 1] }],
    [{ id: 'a'.repeat(64), pages: [1, 2, 3, 4, 5] }],
  ])('rejects malformed references %j', (ref) =>
    expect(() => validateVisualAttachments(ref)).toThrow(),
  );

  test('rejects changed snapshots and symlinked directories/files', async () => {
    const root = tempDir();
    const ref = await saveVisualSnapshot(
      root,
      { pdf: 'test', images: [] },
      [1],
    );
    const file = path.join(root, '.visual-snapshots', `${ref.id}.json`);
    await fs.writeFile(file, 'changed');
    await expect(loadVisualSnapshot(root, ref)).rejects.toThrow('integrity');
    await fs.rm(file);
    await fs.symlink(path.join(root, 'secret'), file);
    await fs.writeFile(path.join(root, 'secret'), 'private');
    await expect(loadVisualSnapshot(root, ref)).rejects.toThrow('symlink');
    const other = tempDir();
    await fs.symlink(
      path.join(root, '.visual-snapshots'),
      path.join(other, '.visual-snapshots'),
    );
    await expect(
      saveVisualSnapshot(other, { pdf: 'test', images: [] }, [1]),
    ).rejects.toThrow('symlink');
  });
});

test('identical page reads reuse deterministic snapshots', async () => {
  const { root, file, ref } = await fixture();
  const repeated = await readPdfPages(file, {
    pages: '2,4',
    workspaceRoot: root,
    outputDir: path.join(root, 'rendered-again'),
    runtimeUrl,
  });
  expect(repeated.visualAttachments).toEqual([ref]);
});

test('does not retry a rejected request after visible stream output', async () => {
  const { ref } = await fixture();
  const { callWithVisualContent, setVisualMediaAllowed } = await import(
    '../container/src/providers/visual-content.js'
  );
  const { ProviderRequestError } = await import(
    '../container/src/providers/shared.js'
  );
  setVisualMediaAllowed(true);
  const call = vi.fn(async () => {
    throw new ProviderRequestError(400, 'Unsupported PDF');
  });
  await expect(
    callWithVisualContent(
      {
        ...base,
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        enableRag: false,
        requestHeaders: undefined,
        isLocal: false,
        contextWindow: undefined,
        thinkingFormat: undefined,
        messages: [{ role: 'user', content: 'read', visualAttachments: [ref] }],
      },
      call,
      () => true,
    ),
  ).rejects.toThrow('Unsupported PDF');
  expect(call).toHaveBeenCalledTimes(1);
});

test('missing snapshots report unavailable visuals and keep text', async () => {
  const { root, ref } = await fixture();
  await fs.rm(path.join(root, '.visual-snapshots'), { recursive: true });
  const { setVisualMediaAllowed } = await import(
    '../container/src/providers/visual-content.js'
  );
  setVisualMediaAllowed(true);
  const { callRoutedModel } = await import(
    '../container/src/providers/router.js'
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const wire = String(init.body);
      expect(wire).toContain('extracted evidence');
      expect(wire).toContain('snapshot missing or invalid');
      expect(wire).not.toContain('base64');
      return response('openai');
    }),
  );
  await callRoutedModel({
    ...base,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5',
    messages: [
      { role: 'user', content: 'extracted evidence', visualAttachments: [ref] },
    ],
  });
});

test('prompt diagnostics omit binary PDF and image payloads', async () => {
  const { logLastPrompt } = await import(
    '../container/src/providers/shared.js'
  );
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  logLastPrompt({
    provider: 'openai',
    model: 'gpt-5',
    kind: 'test',
    request: {
      file_data: 'data:application/pdf;base64,private-pdf',
      image_url: 'data:image/png;base64,private-image',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'private-source',
      },
      images: ['private-ollama'],
    },
  });
  const encoded = String(log.mock.calls[0][0]).split(' ')[1];
  const diagnostic = Buffer.from(encoded, 'base64').toString();
  expect(diagnostic).not.toContain('private-');
  expect(diagnostic).toContain('[binary omitted]');
});

test('concurrent snapshots are atomic and a fresh read repairs incomplete storage', async () => {
  const root = tempDir();
  const snapshot = { pdf: 'test', images: [] };
  const refs = await Promise.all(
    Array.from({ length: 4 }, () => saveVisualSnapshot(root, snapshot, [1])),
  );
  expect(new Set(refs.map((ref) => ref.id)).size).toBe(1);
  const file = path.join(root, '.visual-snapshots', `${refs[0].id}.json`);
  await fs.writeFile(file, '{');
  const repaired = await saveVisualSnapshot(root, snapshot, [1]);
  expect(await loadVisualSnapshot(root, repaired)).toMatchObject(snapshot);
});
