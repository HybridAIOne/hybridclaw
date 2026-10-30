import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';
import { useTempDir } from './test-utils.ts';

const repoRoot = process.cwd();
const runtimeToolsDir = path.join(repoRoot, 'container', 'tools');
if (!fs.existsSync(path.join(runtimeToolsDir, 'node_modules'))) {
  throw new Error(
    'container/tools/node_modules is missing; run `npm run setup`.',
  );
}
const { burn } = createRequire(path.join(runtimeToolsDir, 'package.json'))(
  '@kenjiuno/msgreader/lib/Burner',
) as {
  burn: (
    entries: {
      name: string;
      type: number;
      length: number;
      binaryProvider?: () => ArrayLike<number>;
      children?: number[];
    }[],
  ) => Uint8Array;
};

const makeTempDir = useTempDir('hybridclaw-outlook-msg-test-');

interface CfbNode {
  name: string;
  data?: Uint8Array;
  children?: CfbNode[];
}

const PT_LONG = 0x0003;
const PT_SYSTIME = 0x0040;

function text(tag: string, value: string): CfbNode {
  return {
    name: `__substg1.0_${tag}001F`,
    data: Buffer.from(value, 'utf16le'),
  };
}

function binary(tag: string, value: Uint8Array): CfbNode {
  return { name: `__substg1.0_${tag}0102`, data: value };
}

// [MS-OXMSG] property stream: header, then 16-byte fixed-size entries.
function properties(
  headerBytes: number,
  entries: { id: number; type: number; value: bigint }[],
): CfbNode {
  const data = Buffer.alloc(headerBytes + entries.length * 16);
  entries.forEach(({ id, type, value }, index) => {
    const offset = headerBytes + index * 16;
    data.writeUInt32LE(((id << 16) | type) >>> 0, offset);
    data.writeUInt32LE(0x6, offset + 4);
    data.writeBigUInt64LE(value, offset + 8);
  });
  return { name: '__properties_version1.0', data };
}

function recipient(
  index: number,
  type: 1 | 2,
  name: string,
  address: string,
): CfbNode {
  return {
    name: `__recip_version1.0_#${index.toString(16).padStart(8, '0')}`,
    children: [
      properties(8, [{ id: 0x0c15, type: PT_LONG, value: BigInt(type) }]),
      text('3001', name),
      text('39FE', address),
    ],
  };
}

function fileAttachment(
  index: number,
  name: string,
  mimeType: string,
  data: string,
): CfbNode {
  return {
    name: `__attach_version1.0_#${index.toString(16).padStart(8, '0')}`,
    children: [
      properties(8, [{ id: 0x3705, type: PT_LONG, value: 1n }]),
      text('3707', name),
      text('370E', mimeType),
      binary('3701', Buffer.from(data)),
    ],
  };
}

function burnCfb(children: CfbNode[]): Buffer {
  const entries: Parameters<typeof burn>[0] = [
    { name: 'Root Entry', type: 5, length: 0, children: [] },
  ];
  const add = (node: CfbNode): number => {
    const index = entries.length;
    if (node.data) {
      const data = node.data;
      entries.push({
        name: node.name,
        type: 2,
        length: data.length,
        // burn() copies from data.buffer and ignores byteOffset.
        binaryProvider: () => new Uint8Array(data),
      });
      return index;
    }
    const entry = {
      name: node.name,
      type: 1,
      length: 0,
      children: [] as number[],
    };
    entries.push(entry);
    entry.children = (node.children ?? []).map(add);
    return index;
  };
  entries[0].children = children.map(add);
  return Buffer.from(burn(entries));
}

function fixtureMsg(): Buffer {
  const deliveredAt = BigInt(Date.UTC(2026, 9, 1, 9, 30));
  const filetime = (deliveredAt + 11_644_473_600_000n) * 10_000n;
  const forwarded: CfbNode[] = [
    text('0037', 'Order 4711'),
    text('0C1A', 'Shop Orders'),
    text('5D01', 'orders@shop.example'),
    text(
      '1013',
      '<html><body><p>Order&nbsp;4711 is attached.</p></body></html>',
    ),
    recipient(0, 1, 'Buyer', 'buyer@example.com'),
    fileAttachment(0, 'order.pdf', 'application/pdf', '%PDF-1.4 order 4711'),
  ];
  return burnCfb([
    properties(32, [{ id: 0x0e06, type: PT_SYSTIME, value: filetime }]),
    text('0037', 'Fwd: Order 4711'),
    text('0C1A', 'Alice Example'),
    text('5D01', 'alice@example.com'),
    text('1000', 'Please book the order below.'),
    recipient(0, 1, 'Bob Example', 'bob@example.com'),
    recipient(1, 2, 'Carol Example', 'carol@example.com'),
    fileAttachment(0, '../notes.txt', 'text/plain', 'internal notes'),
    {
      name: '__attach_version1.0_#00000001',
      children: [
        properties(8, [{ id: 0x3705, type: PT_LONG, value: 5n }]),
        text('3001', 'Order 4711'),
        { name: '__substg1.0_3701000D', children: forwarded },
      ],
    },
  ]);
}

function runExtract(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['skills/outlook-msg/scripts/extract_msg.mjs', ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: path.join(runtimeToolsDir, 'node_modules'),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`extract_msg failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

test('extract_msg prints headers and body and extracts nested attachments', () => {
  const dir = makeTempDir();
  const msgPath = path.join(dir, 'forward.msg');
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(msgPath, fixtureMsg());

  const stdout = runExtract([msgPath, '--out', outDir]);

  expect(stdout).toContain('From: Alice Example <alice@example.com>');
  expect(stdout).toContain('To: Bob Example <bob@example.com>');
  expect(stdout).toContain('Cc: Carol Example <carol@example.com>');
  expect(stdout).toContain('Date: Thu, 01 Oct 2026 09:30:00 GMT');
  expect(stdout).toContain('Subject: Fwd: Order 4711');
  expect(stdout).toContain('Please book the order below.');
  expect(stdout).toContain(
    `=== Embedded message: ${path.join(outDir, 'Order 4711')} ===`,
  );
  expect(stdout).toContain('From: Shop Orders <orders@shop.example>');
  expect(stdout).toContain('To: Buyer <buyer@example.com>');
  expect(stdout).toContain('Order 4711 is attached.');
  expect(fs.readFileSync(path.join(outDir, 'notes.txt'), 'utf8')).toBe(
    'internal notes',
  );
  expect(
    fs.readFileSync(path.join(outDir, 'Order 4711', 'order.pdf'), 'utf8'),
  ).toBe('%PDF-1.4 order 4711');
  expect(fs.readdirSync(dir).sort()).toEqual(['forward.msg', 'out']);
});

test('extract_msg --json describes attachments and nested messages', () => {
  const dir = makeTempDir();
  const msgPath = path.join(dir, 'forward.msg');
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(msgPath, fixtureMsg());

  const summary = JSON.parse(runExtract([msgPath, '--out', outDir, '--json']));

  expect(summary).toMatchObject({
    subject: 'Fwd: Order 4711',
    to: ['Bob Example <bob@example.com>'],
    cc: ['Carol Example <carol@example.com>'],
    body: 'Please book the order below.',
    attachments: [
      {
        name: 'notes.txt',
        path: path.join(outDir, 'notes.txt'),
        size: 14,
        contentType: 'text/plain',
      },
    ],
    messages: [
      {
        subject: 'Order 4711',
        folder: path.join(outDir, 'Order 4711'),
        body: 'Order 4711 is attached.',
        attachments: [
          {
            name: 'order.pdf',
            path: path.join(outDir, 'Order 4711', 'order.pdf'),
            contentType: 'application/pdf',
          },
        ],
        messages: [],
      },
    ],
  });
});
