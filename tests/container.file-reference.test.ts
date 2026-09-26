import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_WORKSPACE_ROOT = process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
const ORIGINAL_WORKSPACE_DISPLAY_ROOT =
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;

let workspaceRoot = '';

// A byte sequence that is not valid UTF-8, so a test failure caused by text
// round-tripping instead of binary handling is visible rather than silent.
const BINARY_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01,
]);

async function loadFileReference() {
  vi.resetModules();
  return import('../container/src/file-reference.js');
}

async function loadTools() {
  vi.resetModules();
  return import('../container/src/tools.js');
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-file-reference-'),
  );
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/workspace';
});

afterEach(() => {
  if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
  if (ORIGINAL_WORKSPACE_ROOT === undefined) {
    delete process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
  } else {
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = ORIGINAL_WORKSPACE_ROOT;
  }
  if (ORIGINAL_WORKSPACE_DISPLAY_ROOT === undefined) {
    delete process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;
  } else {
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT =
      ORIGINAL_WORKSPACE_DISPLAY_ROOT;
  }
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
        content: `${'A'.repeat(40)}...${'B'.repeat(40)}`,
      }),
    ).toThrow(/abbreviated base64/);
  });

  test('rejects an oversized inline payload', async () => {
    const { assertNoPastedBinaryPayload, INLINE_BASE64_MAX_CHARS } =
      await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({
        content_base64: 'A'.repeat(INLINE_BASE64_MAX_CHARS + 1),
      }),
    ).toThrow(/inline base64 payload/);
  });

  test('rejects an oversized payload nested in a data url', async () => {
    const { assertNoPastedBinaryPayload, INLINE_BASE64_MAX_CHARS } =
      await loadFileReference();

    expect(() =>
      assertNoPastedBinaryPayload({
        json: {
          image: `data:image/png;base64,${'A'.repeat(INLINE_BASE64_MAX_CHARS + 1)}`,
        },
      }),
    ).toThrow(/inline base64 payload/);
  });

  test('rejects a line-wrapped oversized payload', async () => {
    const { assertNoPastedBinaryPayload, INLINE_BASE64_MAX_CHARS } =
      await loadFileReference();
    const wrapped = ('A'.repeat(76) + '\n').repeat(
      Math.ceil((INLINE_BASE64_MAX_CHARS + 1) / 76),
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
  test('expands references before the tool runs', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), BINARY_BYTES);
    const { executeTool } = await loadTools();

    await executeTool(
      'write',
      JSON.stringify({
        path: 'encoded.txt',
        contents: '<file-base64:logo.png>',
      }),
    );

    const written = fs.readFileSync(
      path.join(workspaceRoot, 'encoded.txt'),
      'utf8',
    );
    expect(written).toBe(BINARY_BYTES.toString('base64'));
  });

  test('does not apply the inline payload guard to its own expansion', async () => {
    // 92 KB expands to ~123k base64 characters, far over the inline limit.
    // The guard has to run on what the model wrote, not on what the runtime
    // substituted, or every real upload trips it.
    const payload = Buffer.alloc(92321);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;
    fs.writeFileSync(path.join(workspaceRoot, 'logo.png'), payload);
    const { executeTool } = await loadTools();

    await executeTool(
      'write',
      JSON.stringify({
        path: 'encoded.txt',
        contents: '<file-base64:logo.png>',
      }),
    );

    const written = fs.readFileSync(
      path.join(workspaceRoot, 'encoded.txt'),
      'utf8',
    );
    expect(written).toBe(payload.toString('base64'));
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
    const { executeTool } = await loadTools();

    const output = await executeTool(
      'write',
      JSON.stringify({ path: 'out.txt', contents: '<file-base64:missing.png>' }),
    );

    expect(output).toMatch(/not found/);
    expect(fs.existsSync(path.join(workspaceRoot, 'out.txt'))).toBe(false);
  });
});
