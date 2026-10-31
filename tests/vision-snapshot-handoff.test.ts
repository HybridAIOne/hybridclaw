import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { expect, test, vi } from 'vitest';
import { saveVisualSnapshot } from '../container/shared/visual-snapshots.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

async function fixture(pages = [3, 7], images = ['cGFnZS0z', 'cGFnZS03']) {
  const root = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  const ref = await saveVisualSnapshot(
    root,
    { pdf: pages.length ? 'cGRm' : '', images },
    pages,
  );
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    return Response.json({
      choices: [
        {
          message: { role: 'assistant', content: 'Selected image evidence.' },
          finish_reason: 'stop',
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetch);
  const tools = await import('../container/src/tools.js');
  const { setModelContext, setTaskModelPolicies } = await import(
    '../container/src/model-context.js'
  );
  setModelContext({
    provider: 'openrouter',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'openrouter/example/text-model',
    chatbotId: '',
  });
  const visionPolicy = {
    provider: 'openrouter' as const,
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'openrouter/example/image-model',
    chatbotId: '',
  };
  setTaskModelPolicies({ vision: visionPolicy });
  tools.setMediaContext([], [], true, false);
  const analyze = (args: Record<string, unknown> = {}) =>
    tools.executeToolWithMetadata(
      'vision_analyze',
      JSON.stringify({
        snapshot: ref,
        page: pages[0],
        question: 'Describe the selected image.',
        ...args,
      }),
    );
  return {
    root,
    ref,
    fetch,
    tools,
    analyze,
    setTaskModelPolicies,
    visionPolicy,
  };
}

test('a text-only primary gets an actionable durable reference for its configured vision tool', async () => {
  const { ref, fetch, tools } = await fixture();
  const { callWithVisualContent } = await import(
    '../container/src/providers/visual-content.js'
  );
  let sent: ChatMessage[] = [];
  await callWithVisualContent(
    {
      provider: 'openrouter',
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'openrouter/example/text-model',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      maxTokens: undefined,
      isLocal: false,
      contextWindow: undefined,
      thinkingFormat: undefined,
      tools: tools.TOOL_DEFINITIONS.filter(
        (tool) => tool.function.name === 'vision_analyze',
      ),
      messages: [
        {
          role: 'user',
          content: 'Inspect selected pages.',
          visualAttachments: [ref],
        },
      ],
    },
    async (request) => {
      sent = request.messages;
      return {
        choices: [
          {
            message: { role: 'assistant', content: 'Inspecting.' },
            finish_reason: 'stop',
          },
        ],
      };
    },
  );
  const text = sent
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
        : [],
    )
    .join('\n');
  const reference = text.match(
    /\{"id":"[a-f0-9]{64}","pages":\[[\d,]*\]\}/,
  )?.[0];
  expect(reference).toBeDefined();
  const snapshot = JSON.parse(reference!);
  expect(snapshot).toEqual(ref);
  expect(text).toContain('vision_analyze');
  expect(JSON.stringify(sent)).not.toContain('base64');
  const result = await tools.executeToolWithMetadata(
    'vision_analyze',
    JSON.stringify({ snapshot, page: 7, question: 'Inspect the selected page.' }),
  );
  expect(result.isError).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(body.model).toBe('example/image-model');
  expect(JSON.stringify(body.messages)).toContain(
    'data:image/png;base64,cGFnZS03',
  );
  expect(JSON.stringify(body.messages)).not.toContain('cGFnZS0z');
});

test('an image snapshot remains usable after worker modules are replaced', async () => {
  const { ref, fetch } = await fixture([], ['aW1hZ2U=']);
  vi.resetModules();
  const tools = await import('../container/src/tools.js');
  const { setModelContext } = await import('../container/src/model-context.js');
  setModelContext({
    provider: 'openrouter',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'openrouter/example/image-model',
    chatbotId: '',
  });
  tools.setMediaContext([], [], true, false);
  const result = await tools.executeToolWithMetadata(
    'vision_analyze',
    JSON.stringify({ snapshot: ref, question: 'Describe this image.' }),
  );
  expect(result.isError).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([undefined, 1, 3.5, '3', -1])(
  'a multi-page snapshot rejects ambiguous or unselected page %j',
  async (page) => {
    const { analyze, fetch } = await fixture();
    expect((await analyze({ page })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each(['permission', 'disabled'] as const)(
  'snapshot analysis respects %s denial',
  async (denial) => {
    const { analyze, fetch, tools, setTaskModelPolicies, visionPolicy } =
      await fixture();
    if (denial === 'permission') tools.setMediaContext([], [], false, true);
    else
      setTaskModelPolicies({
        vision: { ...visionPolicy, error: 'Vision is disabled.' },
      });
    expect((await analyze()).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([
  'missing',
  'corrupt',
  'traversal',
  'symlink',
  'wrong-pages',
] as const)('snapshot analysis refuses %s evidence', async (failure) => {
  const { root, ref, analyze, fetch } = await fixture();
  const file = path.join(root, '.visual-snapshots', `${ref.id}.json`);
  if (failure === 'missing') await fs.unlink(file);
  if (failure === 'corrupt') await fs.appendFile(file, ' ');
  if (failure === 'symlink') {
    const other = path.join(root, 'other.json');
    await fs.rename(file, other);
    await fs.symlink(other, file);
  }
  const snapshot =
    failure === 'traversal'
      ? { ...ref, id: '../other' }
      : failure === 'wrong-pages'
        ? { ...ref, pages: [3, 8] }
        : ref;
  expect((await analyze({ snapshot })).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test('unrendered PDF evidence is refused without sending a model request', async () => {
  const { analyze, fetch } = await fixture([3], []);
  expect((await analyze()).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test('snapshot arguments cannot silently override a file source', async () => {
  const { analyze, fetch } = await fixture();
  expect((await analyze({ image_url: 'image.png' })).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test('a real PDF read remains analyzable after its rendering scratch directory is removed', async () => {
  const { root, tools, fetch } = await fixture();
  await fs.mkdir(path.join(root, 'skills'), { recursive: true });
  await fs.symlink(path.resolve('skills/pdf'), path.join(root, 'skills/pdf'));
  const document = await PDFDocument.create();
  document.addPage([80, 80]);
  document.addPage([80, 80]).drawText('Chart', { x: 5, y: 40, size: 12 });
  const file = path.join(root, 'document.pdf');
  await fs.writeFile(file, await document.save());
  const mkdtemp = fs.mkdtemp.bind(fs);
  let scratch = '';
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (...args) => {
    const directory = await mkdtemp(...args);
    if (String(args[0]).includes('hybridclaw-pdf-')) {
      scratch = String(directory);
      tempDir.track(scratch);
    }
    return directory;
  });
  const read = await tools.executeToolWithMetadata(
    'read',
    JSON.stringify({ path: file, pages: '2' }),
  );
  expect(read.isError).toBe(false);
  expect(read.visualAttachments).toHaveLength(1);
  expect(scratch).not.toBe('');
  await expect(fs.stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  const result = await tools.executeToolWithMetadata(
    'vision_analyze',
    JSON.stringify({
      snapshot: read.visualAttachments![0],
      question: 'Describe the chart.',
    }),
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.output).page).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  const image = body.messages[0].content.find(
    (part: { type: string }) => part.type === 'image_url',
  ).image_url.url;
  expect(
    Buffer.from(image.split(',')[1], 'base64').subarray(0, 8).toString('hex'),
  ).toBe('89504e470d0a1a0a');
});

test('snapshot analysis retains the existing single-image byte limit', async () => {
  const { analyze, fetch } = await fixture(
    [1],
    [Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')],
  );
  expect((await analyze()).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([null, '3', 3.5])(
  'a single-page snapshot rejects invalid page %j',
  async (page) => {
    const { analyze, fetch } = await fixture([3], ['cGFnZS0z']);
    expect((await analyze({ page })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);

test('a reference from another workspace grants no access', async () => {
  const { analyze, fetch } = await fixture();
  const other = tempDir();
  const ref = await saveVisualSnapshot(
    other,
    { pdf: '', images: ['b3RoZXI='] },
    [],
  );
  expect((await analyze({ snapshot: ref, page: undefined })).isError).toBe(
    true,
  );
  expect(fetch).not.toHaveBeenCalled();
});
