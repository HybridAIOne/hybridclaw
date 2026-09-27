import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-file-reference-');
useCleanMocks({
  restoreAllMocks: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

let workspaceRoot = '';

// A byte sequence that is not valid UTF-8, so a test failure caused by text
// round-tripping instead of binary handling is visible rather than silent.
const BINARY_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01,
]);

// Deterministic bytes whose base64 mixes digits and both letter cases, as any
// real encoded file does.
function encodedPayload(minChars: number): string {
  const bytes = Buffer.alloc(Math.ceil((minChars * 3) / 4) + 3);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
  return bytes.toString('base64');
}

async function loadFileReference() {
  vi.resetModules();
  return import('../container/src/file-reference.js');
}

async function loadTools() {
  vi.resetModules();
  return import('../container/src/tools.js');
}

// `http_request` is the built-in that sends its arguments out of the sandbox,
// so it stands in for MCP and plugin tools here: the gateway call is the
// outbound request whose body must carry the bytes.
async function loadHttpRequestTool() {
  const tools = await loadTools();
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    text: async () =>
      JSON.stringify({ ok: true, status: 201, body: '{"content":{}}' }),
  });
  vi.stubGlobal('fetch', fetchMock);
  tools.setGatewayContext('http://127.0.0.1:9000', 'test-token', 'web', []);
  return { ...tools, fetchMock };
}

function sentJson(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body).json as Record<string, unknown>;
}

function contentsApiCall(content: string): string {
  return JSON.stringify({
    url: 'https://api.github.com/repos/user_a/site/contents/public/logo.png',
    method: 'PUT',
    json: { message: 'chore: add logo', content },
  });
}

beforeEach(() => {
  workspaceRoot = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
});

describe('expandFileReferences', () => {
  test('replaces a reference with the file content as base64', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { expandFileReferences } = await loadFileReference();

    const result = expandFileReferences({
      content_base64: '<file-base64:logo.png>',
    });

    expect(result.args.content_base64).toBe(BINARY_BYTES.toString('base64'));
    expect(result.expansions).toEqual([
      { path: 'logo.png', bytes: BINARY_BYTES.length },
    ]);
  });

  test('round-trips the exact bytes, not a utf-8 reinterpretation', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { expandFileReferences } = await loadFileReference();

    const result = expandFileReferences({ body: '<file-base64:logo.png>' });
    const decoded = Buffer.from(String(result.args.body), 'base64');

    expect(decoded.equals(BINARY_BYTES)).toBe(true);
  });

  test('carries a realistic payload through without truncation', async () => {
    // The incident this placeholder exists for: a 92 KB PNG base64-encoded in
    // `bash` and retyped into a tool argument arrived as 10% of its bytes.
    const payload = Buffer.alloc(92321);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), payload);
    const { expandFileReferences } = await loadFileReference();

    const result = expandFileReferences({
      content_base64: '<file-base64:logo.png>',
    });
    const decoded = Buffer.from(String(result.args.content_base64), 'base64');

    expect(decoded.length).toBe(payload.length);
    expect(decoded.equals(payload)).toBe(true);
  });

  test('expands references nested in objects and arrays', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { expandFileReferences } = await loadFileReference();

    const result = expandFileReferences({
      json: { content: '<file-base64:logo.png>', message: 'chore: add logo' },
      attachments: ['<file-base64:logo.png>'],
    });

    const encoded = BINARY_BYTES.toString('base64');
    expect((result.args.json as Record<string, unknown>).content).toBe(encoded);
    expect((result.args.json as Record<string, unknown>).message).toBe(
      'chore: add logo',
    );
    expect((result.args.attachments as string[])[0]).toBe(encoded);
    expect(result.expansions).toHaveLength(2);
  });

  test('accepts the display root path form', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { expandFileReferences } = await loadFileReference();

    const result = expandFileReferences({
      content: '<file-base64:/workspace/logo.png>',
    });

    expect(result.args.content).toBe(BINARY_BYTES.toString('base64'));
  });

  test('leaves arguments untouched when no reference is present', async () => {
    const { expandFileReferences } = await loadFileReference();
    const args = { content: 'plain text', nested: { value: 1 } };

    const result = expandFileReferences(args);

    expect(result.args).toBe(args);
    expect(result.expansions).toEqual([]);
  });

  test('rejects a reference outside the allowed roots', async () => {
    const outside = path.join(os.tmpdir(), 'hybridclaw-outside-reference.bin');
    fs.writeFileSync(outside, BINARY_BYTES);
    const { expandFileReferences, FileReferenceError } =
      await loadFileReference();

    try {
      expect(() =>
        expandFileReferences({ content: `<file-base64:${outside}>` }),
      ).toThrow(FileReferenceError);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test('rejects a missing file', async () => {
    const { expandFileReferences } = await loadFileReference();

    expect(() =>
      expandFileReferences({ content: '<file-base64:missing.png>' }),
    ).toThrow(/not found/);
  });

  test('rejects a directory', async () => {
    fs.mkdirSync(path.join(workspaceRoot, 'assets'));
    const { expandFileReferences } = await loadFileReference();

    expect(() =>
      expandFileReferences({ content: '<file-base64:assets>' }),
    ).toThrow(/not a file/);
  });

  test('rejects an empty reference', async () => {
    const { expandFileReferences } = await loadFileReference();

    expect(() => expandFileReferences({ content: '<file-base64:>' })).toThrow(
      /empty/,
    );
  });

  test('rejects a reference embedded in a longer string', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { expandFileReferences } = await loadFileReference();

    expect(() =>
      expandFileReferences({
        content: 'data:image/png;base64,<file-base64:logo.png>',
      }),
    ).toThrow(/entire argument value/);
  });

  test('rejects a file over the size limit', async () => {
    const { expandFileReferences, FILE_REFERENCE_MAX_BYTES } =
      await loadFileReference();
    fs.writeFileSync(
      path.join(workspaceRoot, 'huge.bin'),
      Buffer.alloc(FILE_REFERENCE_MAX_BYTES + 1),
    );

    expect(() =>
      expandFileReferences({ content: '<file-base64:huge.bin>' }),
    ).toThrow(/exceeds/);
  });
});

describe('assertNoPastedBinaryPayload', () => {
  test('rejects the abbreviated payload that reached production', async () => {
    // Verbatim content of snoller/psychoanalyse-akademie public/logo.png at
    // commit e26d5e3a: 27 bytes where a 92 KB PNG was expected.
    const { assertNoPastedBinaryPayload } = await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({
        content: 'iVBORw0KGgoAAAANSUhEUgAA...',
      }),
    ).toThrow(/abbreviated base64/);
  });

  test('rejects an ellipsis in the middle of a payload', async () => {
    const { assertNoPastedBinaryPayload } = await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({
        content: 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8x…ABJRU5ErkJggg==',
      }),
    ).toThrow(/abbreviated base64/);
  });

  test.each([
    ['an abbreviated commit hash', 'e45bdf4b1c3a5f2e9d8c7b6a5f4e3d2c...'],
    ['a compare range of plain names', 'develop...release/candidateVersion'],
    ['a long run of one letter', 'x'.repeat(24_000)],
  ])('allows %s', async (_label, value) => {
    const { assertNoPastedBinaryPayload } = await loadFileReference();

    expect(() => assertNoPastedBinaryPayload({ value })).not.toThrow();
  });

  test('rejects an oversized inline payload', async () => {
    const { assertNoPastedBinaryPayload, INLINE_BASE64_MAX_CHARS } =
      await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({
        content_base64: encodedPayload(INLINE_BASE64_MAX_CHARS + 1),
      }),
    ).toThrow(/inline base64 payload/);
  });

  test('rejects an oversized payload nested in a data url', async () => {
    const { assertNoPastedBinaryPayload, INLINE_BASE64_MAX_CHARS } =
      await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({
        json: {
          image: `data:image/png;base64,${encodedPayload(INLINE_BASE64_MAX_CHARS + 1)}`,
        },
      }),
    ).toThrow(/inline base64 payload/);
  });

  test('rejects a line-wrapped oversized payload', async () => {
    const { assertNoPastedBinaryPayload, INLINE_BASE64_MAX_CHARS } =
      await loadFileReference();
    const wrapped = encodedPayload(INLINE_BASE64_MAX_CHARS + 1).replace(
      /.{76}/g,
      '$&\n',
    );

    expect(() => assertNoPastedBinaryPayload({ body: wrapped })).toThrow(
      /inline base64 payload/,
    );
  });

  test('allows a small inline payload', async () => {
    const { assertNoPastedBinaryPayload } = await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({ content_base64: 'A'.repeat(1024) }),
    ).not.toThrow();
  });

  test('allows source code larger than the limit', async () => {
    const { assertNoPastedBinaryPayload, INLINE_BASE64_MAX_CHARS } =
      await loadFileReference();
    const source = 'export function noop() { return null; }\n'.repeat(
      Math.ceil(INLINE_BASE64_MAX_CHARS / 10),
    );

    expect(() =>
      assertNoPastedBinaryPayload({ path: 'noop.ts', contents: source }),
    ).not.toThrow();
  });

  test('allows prose that ends in an ellipsis', async () => {
    const { assertNoPastedBinaryPayload } = await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({
        text: 'Ich schaue mir das an und melde mich gleich...',
      }),
    ).not.toThrow();
  });

  test('allows the file reference placeholder itself', async () => {
    const { assertNoPastedBinaryPayload } = await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({ content: '<file-base64:logo.png>' }),
    ).not.toThrow();
  });
});

describe('tool dispatch', () => {
  test('sends the referenced bytes and reports what it sent', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { executeTool, fetchMock } = await loadHttpRequestTool();

    const output = await executeTool(
      'http_request',
      contentsApiCall('<file-base64:logo.png>'),
    );

    expect(sentJson(fetchMock).content).toBe(BINARY_BYTES.toString('base64'));
    expect(output).toContain(
      `[file-base64: sent logo.png (${BINARY_BYTES.length} bytes)]`,
    );
  });

  test('does not apply the inline payload guard to its own expansion', async () => {
    // 92 KB expands to ~123k base64 characters, far over the inline limit.
    // The guard has to run on what the model wrote, not on what the runtime
    // substituted, or every real upload trips it.
    const payload = Buffer.alloc(92321);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), payload);
    const { executeTool, fetchMock } = await loadHttpRequestTool();

    await executeTool('http_request', contentsApiCall('<file-base64:logo.png>'));

    expect(sentJson(fetchMock).content).toBe(payload.toString('base64'));
  });

  test('adds no receipt when the call fails', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { executeToolWithMetadata, fetchMock } = await loadHttpRequestTool();
    fetchMock.mockRejectedValue(new Error('connection refused'));

    const result = await executeToolWithMetadata(
      'http_request',
      contentsApiCall('<file-base64:logo.png>'),
    );

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('[file-base64:');
  });

  test('rejects a reference in a tool that keeps its arguments local', async () => {
    // Expanding here would only write base64 text into the file.
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'write',
      JSON.stringify({ path: 'copy.png', contents: '<file-base64:logo.png>' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/does not expand/);
    expect(fs.existsSync(path.join(workspaceRoot, 'copy.png'))).toBe(false);
  });

  test('reports a pasted payload as a tool error', async () => {
    const { executeTool } = await loadTools();

    const output = await executeTool(
      'write',
      JSON.stringify({
        path: 'out.txt',
        contents: 'iVBORw0KGgoAAAANSUhEUgAA...',
      }),
    );

    expect(output).toMatch(/abbreviated base64/);
    expect(fs.existsSync(path.join(workspaceRoot, 'out.txt'))).toBe(false);
  });

  test('reports an unresolvable reference as a tool error', async () => {
    const { executeTool, fetchMock } = await loadHttpRequestTool();

    const output = await executeTool(
      'http_request',
      contentsApiCall('<file-base64:missing.png>'),
    );

    expect(output).toMatch(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
