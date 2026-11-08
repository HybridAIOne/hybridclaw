import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runWorker = useContainerAgentHarness();
function call(id: string, name: string, args: object) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}
const original = 'Existing project notes\n';
const separate = 'New report\n';

test.each([
  {
    name: 'PDF verification chain',
    command:
      'cd . && file input.pdf && (command -v pdfinfo >/dev/null && pdfinfo input.pdf | grep -E "Pages|Title" || echo unavailable)',
    stale: false,
  },
  {
    name: 'byte inspection pipeline',
    command: 'od -c report.md | tail -3; wc -c report.md',
    stale: true,
  },
  {
    name: 'byte range through stdin',
    command: 'od -vAn -t x1 -N 16 -j 0 < report.md',
    stale: true,
  },
  {
    name: 'file format inspection',
    command: 'ls -la report.md && file -bi report.md',
    stale: false,
  },
])(
  '$name completes after a conflict while shell replacement stays blocked',
  async ({ command, stale }) => {
    const unsafe = { command: 'printf replacement > report.md' };
    const run = await runWorker(
      [
        call('conflict', 'write', {
          path: 'report.md',
          contents: 'Replacement\n',
          ...(stale
            ? { overwrite: true, expected_content: 'Different notes\n' }
            : {}),
        }),
        call('inspect', 'bash', { command }),
        call('separate', 'write', { path: 'separate.md', contents: separate }),
        call('unsafe', 'bash', unsafe),
        call('unsafe-again', 'bash', unsafe),
        { role: 'assistant', content: 'Finished permitted work.' },
      ],
      { approvalMode: 'full' },
      { 'report.md': original },
      {
        prepare: async (dir) => {
          const pdf = await PDFDocument.create();
          pdf.addPage();
          fs.writeFileSync(path.join(dir, 'input.pdf'), await pdf.save());
          return {};
        },
      },
    );
    const rows = run.output.toolExecutions ?? [];
    expect(rows[0]).toMatchObject({ name: 'write', isError: true });
    expect(rows[1]).toMatchObject({
      name: 'bash',
      isError: false,
      blocked: false,
    });
    expect(rows[1].result.length).toBeGreaterThan(5);
    expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
      original,
    );
    expect(fs.existsSync(path.join(run.dir, 'separate.md'))).toBe(true);
    if (fs.existsSync(path.join(run.dir, 'separate.md')))
      expect(fs.readFileSync(path.join(run.dir, 'separate.md'), 'utf8')).toBe(
        separate,
      );
    expect(run.output.pendingApproval?.toolName).toBe('bash');
    expect(rows.at(-1)).toMatchObject({ blocked: true });
  },
  20000,
);

test('magic compilation remains blocked after file-format reads become automatic', async () => {
  const run = await runWorker(
    [
      call('conflict', 'write', {
        path: 'report.md',
        contents: 'Replacement\n',
      }),
      call('compile', 'bash', { command: 'file -C -m custom.magic' }),
      call('compile-again', 'bash', { command: 'file -C -m custom.magic' }),
    ],
    { approvalMode: 'full' },
    { 'report.md': original, 'custom.magic': '0 string MAGIC fixture\n' },
  );
  expect(run.output.pendingApproval?.toolName).toBe('bash');
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    original,
  );
  expect(fs.existsSync(path.join(run.dir, 'custom.magic.mgc'))).toBe(false);
}, 20000);
