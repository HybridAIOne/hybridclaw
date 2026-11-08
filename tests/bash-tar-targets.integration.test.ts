import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const outsideRoot = '/opt/hybridclaw-policy-fixture-missing';
const commands = {
  extract: (target: string) => `tar -xf bundle.tar -C ${target}`,
  oldExtract: (target: string) => `tar xf bundle.tar -C ${target}`,
  create: (target: string) => `tar -cf ${target} notes.txt`,
};

test.each(
  (Object.keys(commands) as Array<keyof typeof commands>).flatMap((operation) =>
    [true, false].map((outside) => ({ operation, outside })),
  ),
)(
  'real archive work preserves the fence: $operation outside=$outside',
  async ({ operation, outside }) => {
    expect(fs.existsSync(outsideRoot)).toBe(false);
    let command = '';
    let requests = 0;
    const run = await runAgent(
      async () =>
        ++requests === 1
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'archive',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: JSON.stringify({ command }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'Finished.' },
      { approvalMode: 'full' },
      { 'notes.txt': 'Archive fixture\n' },
      {
        prepare: async (dir) => {
          execFileSync('tar', ['-cf', 'bundle.tar', 'notes.txt'], { cwd: dir });
          fs.mkdirSync(path.join(dir, 'out'));
          const target =
            operation === 'create'
              ? outside
                ? `${outsideRoot}/created.tar`
                : 'created.tar'
              : outside
                ? outsideRoot
                : './out';
          const log = path.join(dir, 'archive.log').replaceAll("'", "'\\''");
          command = `${commands[operation](target)} > '${log}' 2>&1`;
          return {};
        },
      },
    );
    if (outside) {
      expect(run.output.pendingApproval).toBeDefined();
      expect(run.output.toolExecutions?.[0]).toMatchObject({ blocked: true });
      expect(fs.existsSync(path.join(run.dir, 'archive.log'))).toBe(false);
      expect(fs.existsSync(outsideRoot)).toBe(false);
    } else {
      expect(run.output.pendingApproval).toBeUndefined();
      expect(run.output.toolExecutions?.[0]).toMatchObject({
        blocked: false,
        isError: false,
      });
      const content =
        operation === 'create'
          ? execFileSync('tar', ['-xOf', 'created.tar', 'notes.txt'], {
              cwd: run.dir,
              encoding: 'utf8',
            })
          : fs.readFileSync(path.join(run.dir, 'out/notes.txt'), 'utf8');
      expect(content).toBe('Archive fixture\n');
    }
  },
);
