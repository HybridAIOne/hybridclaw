import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const call = (command: string) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{
    id: 'extract-data', type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command }) },
  }],
});

test('literal data reads remain executable after a rejected filename collision', async () => {
  const { output, requests, dir } = await runAgent([
    {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'create-conflict', type: 'function', function: {
        name: 'write', arguments: '{"path":"page.html","contents":"Unrelated replacement."}',
      } }],
    },
    call("sed 's/<[^>]*>//' page.html"),
    { role: 'assistant', content: 'Read the original file.' },
  ], { approvalMode: 'full' }, { 'page.html': '<a>Original content</a>\n' });
  expect(output.pendingApproval).toBeUndefined();
  expect(output.toolExecutions?.[0]).toMatchObject({ name: 'write', isError: true });
  expect(output.toolExecutions?.[1]).toMatchObject({ name: 'bash', isError: false });
  expect(output.toolExecutions?.[1].result).toContain('Original content');
  expect(requests).toHaveLength(3);
  expect(fs.readFileSync(path.join(dir, 'page.html'), 'utf8')).toBe('<a>Original content</a>\n');
});

test('a real worker extracts headings and snippets without a false write or sensitive-path stop', async () => {
  const command = `F=page.html; grep -oE '<a[^>]*>[^<]*' "$F" | sed 's/<[^>]*>//' | head -8; grep -oE 'class="snippet"[^>]*>.{0,80}' "$F" | sed 's/.*class="snippet"[^>]*>//' | head -6`;
  const { output, requests } = await runAgent(
    [call(command), { role: 'assistant', content: 'Extraction completed.' }],
    { approvalMode: 'full' },
    { 'page.html': '<a href="https://example.com">Example heading</a>\n<div class="snippet">Useful snippet</div>\n' },
  );
  expect(output.status).toBe('success');
  expect(output.pendingApproval).toBeUndefined();
  expect(requests).toHaveLength(2);
  expect(output.toolExecutions?.[0]).toMatchObject({ name: 'bash', isError: false, blocked: false });
  expect(output.toolExecutions?.[0].result).toContain('Example heading');
  expect(output.toolExecutions?.[0].result).toContain('Useful snippet');
});

test.each([
  "grep -oE '<a[^>]*>' .env",
  "env -u FEATURE grep -oE '<a[^>]*>' .env",
  "printf '%s' names | xargs grep -oE '<a[^>]*>' .env",
  "find . -name page.html -exec grep -oE '<a[^>]*>' .env \\;",
  "sh -c 'grep -oE \"<a[^>]*>\" .env'",
  "sed 's/.*class=\"snippet\"[^>]*>//' .env",
])('literal patterns cannot hide a sensitive file operand in a real worker: %s', async (command) => {
  const { output, requests, dir } = await runAgent([call(command)], { approvalMode: 'full' }, {
    '.env': 'EXAMPLE_SETTING=synthetic\n',
    'page.html': '<a>Fixture</a>\n',
  });
  expect(output.pendingApproval?.toolName).toBe('bash');
  expect(output.toolExecutions?.[0]).toMatchObject({ blocked: true, approvalDecision: 'required' });
  expect(requests).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('EXAMPLE_SETTING=synthetic\n');
});

test.each([
  "grep -oE '<a[^>]*>' page.html > /opt/hybridclaw-policy-fixture-missing/output.html",
  "sed 's/.*class=\"snippet\"[^>]*>//' page.html > /opt/hybridclaw-policy-fixture-missing/output.html",
  "grep \"$(printf x > /opt/hybridclaw-policy-fixture-missing/output.html)\" page.html",
])('real output writes keep the workspace boundary: %s', async (command) => {
  const target = '/opt/hybridclaw-policy-fixture-missing/output.html';
  expect(fs.existsSync(target)).toBe(false);
  const { output, requests } = await runAgent([call(command)], { approvalMode: 'full' }, {
    'page.html': '<a>Fixture</a>\n',
  });
  expect(output.pendingApproval?.toolName).toBe('bash');
  expect(output.toolExecutions?.[0]).toMatchObject({ blocked: true, approvalDecision: 'required' });
  expect(requests).toHaveLength(1);
  expect(fs.existsSync(target)).toBe(false);
});
