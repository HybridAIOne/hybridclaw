import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('hc-bash-diagnostics-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let root: string;
beforeEach(() => {
  root = temp();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
});

async function decision(command: string, conflict = true) {
  const { TrustedAgentApprovalRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const { recordFileWriteConflict } = await import(
    '../container/src/file-write-conflicts.js'
  );
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(root, 'policy.yaml'),
    path.join(root, 'agent.json'),
    path.join(root, 'all.json'),
    path.join(root, 'legacy.json'),
    undefined,
    path.join(root, 'pending.json'),
  );
  runtime.setSession('diagnostics');
  runtime.setApprovalMode({ mode: 'full' });
  if (conflict)
    await recordFileWriteConflict('diagnostics', path.join(root, 'report.md'));
  return runtime.evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command }),
  });
}

test.each([
  'file report.md',
  'file -bi report.md',
  'file --mime-type --mime-encoding report.md',
  'file -- -C',
  'ls -la report.md && file report.md',
  'file report.md | head -1',
  'command -p -v pdfinfo',
  'command -Vp pdfinfo',
  'od report.md',
  'od -c report.md | tail -3; wc -c report.md',
  'od -An -tx1 -v report.md',
  'od -vAn -t x1 -N 16 -j 0 report.md',
  'od -a -b -c -d -f -i -l -o -s -x report.md',
  'od -A x -t c report.md',
  'od -N16 -j0 report.md',
  'od -- -report.md',
  'od -c - < report.md',
  'od -c report.md >/dev/null 2>&1',
  'cd .',
  'cd -P /workspace && file document.pdf',
  'cd -- ./notes && head -3 report.md',
  'command -v pdfinfo',
  'command -V pdfinfo',
  'command -pV sh',
  'command -v pdfinfo >/dev/null 2>&1',
  'pdfinfo document.pdf',
  'pdfinfo -f 1 -l 2 -box document.pdf',
  'pdfinfo -meta -custom -js document.pdf',
  'pdfinfo -struct -struct-text -isodates -rawdates document.pdf',
  'pdfinfo -dests -url -enc UTF-8 document.pdf',
  'pdfinfo -listenc',
  'pdfinfo --help',
  'pdfinfo -v',
  'pdfinfo document.pdf >/dev/null 2>&1',
  'pdfinfo - < document.pdf',
  'cd /workspace && file document.pdf && (command -v pdfinfo >/dev/null && pdfinfo document.pdf | grep -Ei "pages|title" || echo unavailable) && head -3 report-new.md',
])(
  'read-only verification remains automatic after a conflict: %s',
  async (command) => {
    expect(await decision(command)).toMatchObject({
      tier: 'green',
      pinned: false,
      writeIntent: false,
      decision: 'auto',
    });
  },
);

test.each([
  'file -C -m rules',
  'file --compile --magic-file rules',
  'file -p report.md',
  'file --preserve-date report.md',
  'file -f paths.txt',
  'file --files-from paths.txt',
  'file -z report.md',
  'file --unknown report.md',
  'file .env',
  'file report.md > report.md',
  'file report.md && python3 generated.py',
  '"command" -v sh',
  '(command -v sh)',
  'env command -v sh',
  'command --version',
  'command -v -unknown sh',
  'command -- sh generated.sh',
  'cd /opt/data && touch notes.txt',
  'od -c report.md > report.md',
  'od -c report.md | tee report.md',
  'od -c report.md && python3 generated.py',
  'od -c "$(python3 generated.py)"',
  'od -c <(python3 generated.py)',
  'od -c "$FILE"',
  'od -c *.md',
  'od -c /etc/private.conf',
  'od -c .env',
  'od -c -- .env',
  'od -c < .env',
  'od -c report.md > /tmp/data.txt',
  'od -unknown report.md',
  'od -N',
  'od -N -c report.md',
  'od -A wrong report.md',
  'od -t wrong report.md',
  'od -j missing report.md',
  '"od" -c report.md',
  '(od -c report.md)',
  'env od -c report.md',
  'cd -',
  'cd "$DIR" && file document.pdf',
  'cd ~ && file document.pdf',
  'cd /etc && cat shadow',
  'cd . && printf changed > report.md',
  'cd . && python3 generated.py',
  'command sh generated.sh',
  'command -p sh generated.sh',
  'command -v pdfinfo > report.md',
  'command -v "$(python3 generated.py)"',
  'pdfinfo document.pdf > report.md',
  'pdfinfo document.pdf | tee report.md',
  'pdfinfo document.pdf && python3 generated.py',
  'pdfinfo "$(python3 generated.py)"',
  'pdfinfo <(python3 generated.py)',
  'pdfinfo - < "$SOURCE"',
  'pdfinfo "$SOURCE"',
  'pdfinfo *.pdf',
  'pdfinfo /etc/private.pdf',
  'pdfinfo -opw example-value document.pdf',
  'pdfinfo -unknown document.pdf',
  'pdfinfo -f document.pdf',
  'pdfinfo -l 0 document.pdf',
  'pdfinfo -enc',
  'pdfinfo first.pdf second.pdf',
  '(pdfinfo document.pdf)',
  '"pdfinfo" document.pdf',
])(
  'unrecognized diagnostics, writes and scripts retain approval: %s',
  async (command) => {
    expect(await decision(command)).toMatchObject({
      pinned: true,
      decision: 'required',
    });
  },
);

test.each([
  'pdfinfo input.pdf > /opt/data/metadata.txt',
  'pdfinfo input.pdf > /opt/data/metadata.txt 2>/tmp/log.txt',
  'file report.md > /opt/data/type.txt',
  'od -c report.md >/opt/data/bytes.txt 2>/tmp/log.txt',
  'command -v sh > /opt/data/lookup.txt 2>/tmp/log.txt',
  'command -v sh 1>/opt/data/lookup.txt 2>&1',
  'cd /opt/data && printf changed > notes.txt',
])(
  'diagnostics never exempt workspace writes or sensitive reads without a conflict: %s',
  async (command) => {
    expect(await decision(command, false)).toMatchObject({
      tier: 'red',
      actionKey: 'bash:workspace-fence',
      decision: 'required',
    });
  },
);

test.each(['file .env', 'pdfinfo /etc/private.pdf', 'od < .env'])(
  'sensitive reads stay pinned without a conflict: %s',
  async (command) => {
    expect(await decision(command, false)).toMatchObject({
      tier: 'red',
      pinned: true,
      decision: 'required',
    });
  },
);
