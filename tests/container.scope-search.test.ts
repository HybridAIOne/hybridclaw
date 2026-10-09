import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-scope-search-');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const SCOPE = 's_0123456789ab';
const OTHER_SCOPE = 's_ba9876543210';

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function transcript(sessionId: string, content: string): string {
  return `${JSON.stringify({ sessionId, role: 'user', content })}\n`;
}

// An agent workspace with notes of its own and of two scopes.
function agentWorkspace(): string {
  const root = makeTempDir();
  write(root, 'MEMORY.md', '- Main knows the dentist is on Friday.\n');
  write(root, 'memory/2026-10-01.md', '- Main note about the garden.\n');
  write(root, `scopes/${SCOPE}/MEMORY.md`, '- Work: the quarterly report.\n');
  write(root, `scopes/${SCOPE}/memory/2026-10-02.md`, '- Work note: invoice.\n');
  write(root, `scopes/${OTHER_SCOPE}/MEMORY.md`, '- Family: the school trip.\n');
  write(
    root,
    '.session-transcripts/web_main.jsonl',
    transcript('main-a', 'We talked about the garden fence.'),
  );
  write(
    root,
    `scopes/${SCOPE}/.session-transcripts/ios-work.jsonl`,
    transcript('ios-work', 'We talked about the invoice fence.'),
  );
  write(
    root,
    `scopes/${OTHER_SCOPE}/.session-transcripts/ios-family.jsonl`,
    transcript('ios-family', 'We talked about the school fence.'),
  );
  return root;
}

async function loadTools(workspaceRoot: string) {
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
  return import('../container/src/tools.js');
}

function searchedSessions(output: string): string[] {
  const parsed = JSON.parse(output) as {
    results: Array<{ session_id: string }>;
  };
  return parsed.results.map((result) => result.session_id).sort();
}

test("the main chat's memory search covers every scope's notes", async () => {
  const root = agentWorkspace();
  const { executeTool } = await loadTools(root);

  const result = await executeTool(
    'memory',
    JSON.stringify({ action: 'search', query: 'the' }),
  );

  expect(result).toContain('MEMORY.md:1: - Main knows the dentist');
  expect(result).toContain(`scopes/${SCOPE}/MEMORY.md:1: - Work: the`);
  expect(result).toContain(`scopes/${OTHER_SCOPE}/MEMORY.md:1: - Family: the`);
});

test("the main chat's session_search covers every scope's transcripts", async () => {
  const root = agentWorkspace();
  const { executeTool } = await loadTools(root);

  const result = await executeTool(
    'session_search',
    JSON.stringify({ query: 'fence', limit: 5 }),
  );

  expect(searchedSessions(result)).toEqual([
    'ios-family',
    'ios-work',
    'main-a',
  ]);
});

test('a scoped chat searches only its own scope', async () => {
  const root = agentWorkspace();
  // A scoped chat's worker has the scope's directory as its workspace.
  const { executeTool } = await loadTools(path.join(root, 'scopes', SCOPE));

  const memory = await executeTool(
    'memory',
    JSON.stringify({ action: 'search', query: 'the' }),
  );
  const sessions = await executeTool(
    'session_search',
    JSON.stringify({ query: 'fence', limit: 5 }),
  );
  const read = await executeTool(
    'memory',
    JSON.stringify({ action: 'read', file_path: 'MEMORY.md' }),
  );

  expect(memory).toContain('MEMORY.md:1: - Work: the quarterly report.');
  expect(memory).not.toContain('dentist');
  expect(memory).not.toContain('Family');
  expect(searchedSessions(sessions)).toEqual(['ios-work']);
  expect(read).toContain('quarterly report');
  expect(read).not.toContain('dentist');
});

test('blocked tool patterns keep every connector service but the allowed ones out', async () => {
  const { compileBlockedTools } = await import(
    '../container/src/blocked-tools.js'
  );
  const isBlocked = compileBlockedTools([
    'device_data',
    'hybridai__*__*',
    '!hybridai__dm__*',
    '!hybridai__google_workspace__*',
  ]);

  expect(isBlocked('device_data')).toBe(true);
  expect(isBlocked('hybridai__mailbox__search')).toBe(true);
  expect(isBlocked('hybridai__microsoft_graph__mail_send')).toBe(true);
  expect(isBlocked('hybridai__dm__search_products')).toBe(false);
  expect(isBlocked('hybridai__google_workspace__gmail_search')).toBe(false);
  // Platform tools without a service, and other MCP servers, stay.
  expect(isBlocked('hybridai__web_search')).toBe(false);
  expect(isBlocked('github__create_issue')).toBe(false);
  expect(isBlocked('read')).toBe(false);
  // An exemption never lifts an exact block.
  expect(compileBlockedTools(['read', '!read'])('read')).toBe(true);
});
