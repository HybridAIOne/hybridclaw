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
