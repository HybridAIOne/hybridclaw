import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const wheelName = 'policy_fixture-1.0-py3-none-any.whl';

test.each(
  ['--target ', '--target=', '-qt'].flatMap((option) =>
    [true, false].map((outside) => ({ option, outside })),
  ),
)(
  'a real worker fences pip targets while permitting local installs: $option outside=$outside',
  async ({ option, outside }) => {
    const target = outside
      ? '/opt/hybridclaw-policy-fixture-missing/vendor'
      : './vendor';
    if (outside) expect(fs.existsSync(target)).toBe(false);
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
                  id: 'install',
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
      {},
      {
        prepare: async (dir) => {
          // Outside reproductions use a missing wheel so a broken fence cannot install.
          if (!outside) {
            execFileSync('python3', [
              '-c',
              `
import sys, zipfile
files = {
    'policy_fixture.py': 'VALUE = 42\\n',
    'policy_fixture-1.0.dist-info/METADATA': 'Metadata-Version: 2.1\\nName: policy-fixture\\nVersion: 1.0\\n',
    'policy_fixture-1.0.dist-info/WHEEL': 'Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
    'policy_fixture-1.0.dist-info/RECORD': '',
}
with zipfile.ZipFile(sys.argv[1], 'w') as wheel:
    for name, content in files.items():
        wheel.writestr(name, content)
`,
              path.join(dir, wheelName),
            ]);
          }
          const log = path.join(dir, 'install.log').replaceAll("'", "'\\''");
          command = `env -u FEATURE python3 -m pip install --no-index --no-deps --no-compile --disable-pip-version-check --no-cache-dir ${option}${target} ./${wheelName} > '${log}' 2>&1`;
          return {};
        },
        timeoutMs: 20000,
      },
    );
    if (outside) {
      expect(run.output.pendingApproval).toBeDefined();
      expect(run.output.toolExecutions?.[0]).toMatchObject({ blocked: true });
      expect(fs.existsSync(path.join(run.dir, 'install.log'))).toBe(false);
      expect(fs.existsSync(target)).toBe(false);
    } else {
      expect(run.output.pendingApproval).toBeUndefined();
      expect(run.output.toolExecutions?.[0]).toMatchObject({
        blocked: false,
        isError: false,
      });
      expect(
        fs.readFileSync(path.join(run.dir, 'vendor/policy_fixture.py'), 'utf8'),
      ).toBe('VALUE = 42\n');
      expect(fs.existsSync(path.join(run.dir, 'install.log'))).toBe(true);
    }
  },
);
