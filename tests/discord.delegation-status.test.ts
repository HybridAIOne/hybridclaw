import { afterEach, expect, test, vi } from 'vitest';
import type {
  DelegationStatusEntry,
  DelegationStatusSnapshot,
} from '../src/gateway/delegation-plan.js';

const STARTED_AT = Date.UTC(2026, 9, 21, 12, 0, 0);

function entry(
  overrides: Partial<DelegationStatusEntry> = {},
): DelegationStatusEntry {
  return {
    title: 'Research example.com',
    model: 'parent-model',
    status: 'running',
    toolUses: 0,
    ...overrides,
  };
}

function snapshot(
  entries: DelegationStatusEntry[],
  jobId = 'dlg_test',
): DelegationStatusSnapshot {
  return { jobId, startedAt: STARTED_AT, parentModel: 'parent-model', entries };
}

async function importFresh() {
  vi.resetModules();
  const sent: Array<{ channelId: string; text: string }> = [];
  const edit = vi.fn(async (_payload: { content: string }) => undefined);
  const sendToChannel = vi.fn(async (channelId: string, text: string) => {
    sent.push({ channelId, text });
    return [{ edit }];
  });
  vi.doMock(
    '../src/channels/channel-runtime-loaders.js',
    async (importOriginal) => ({
      ...(await importOriginal<object>()),
      discordRuntimeLoader: { load: async () => ({ sendToChannel }) },
    }),
  );
  const module = await import('../src/channels/discord/delegation-status.js');
  return { ...module, sent, edit, sendToChannel };
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('../src/channels/channel-runtime-loaders.js');
});

test('renders a running job with its current tool call as a code span', async () => {
  const { renderDiscordDelegationStatus } = await importFresh();
  const text = renderDiscordDelegationStatus(
    snapshot([
      entry({
        title: 'Fix *bold* PR',
        toolUses: 1,
        currentTool: 'mcp__github__fetch_file',
        currentToolDetail: 'src/`a`.ts',
      }),
    ]),
    STARTED_AT,
  );
  const lines = text.split('\n');
  expect(lines[0]).toBe(
    `-# Delegating · started <t:${STARTED_AT / 1_000}:R>`,
  );
  expect(lines[1]).toBe('🔄 **Fix \\*bold\\* PR** · 1 tool');
  expect(lines[2]).toBe("-# ↳ `mcp__github__fetch_file src/'a'.ts`");
  expect(text).not.toContain('[Delegate Status]');
});

test.each([
  [entry({ status: 'queued' }), '-# ↳ waiting to start'],
  [entry({ lastTool: 'web_search' }), '-# ↳ thinking after `web_search`'],
  [entry(), '-# ↳ thinking'],
])('renders the activity line for %#', async (job, expected) => {
  const { renderDiscordDelegationStatus } = await importFresh();
  expect(
    renderDiscordDelegationStatus(snapshot([job]), STARTED_AT).split('\n')[2],
  ).toBe(expected);
});

test('collapses a finished single job to one receipt line', async () => {
  const { renderDiscordDelegationStatus } = await importFresh();
  const text = renderDiscordDelegationStatus(
    snapshot([
      entry({
        status: 'completed',
        toolUses: 7,
        tokenCount: 12_300,
        model: 'other-model',
      }),
    ]),
    STARTED_AT + 151_000,
  );
  expect(text).toBe(
    '-# ✅ Research example.com · 7 tools · 12.3k tokens · 2m 31s · other-model',
  );
});

test('summarizes a finished batch with one receipt per job', async () => {
  const { renderDiscordDelegationStatus } = await importFresh();
  const lines = renderDiscordDelegationStatus(
    snapshot([
      entry({ status: 'completed', toolUses: 2 }),
      entry({ title: 'Second', status: 'failed', toolUses: 1 }),
    ]),
    STARTED_AT + 5_000,
  ).split('\n');
  expect(lines).toEqual([
    '-# Delegated 1/2 jobs in 5s',
    '-# ✅ Research example.com · 2 tools',
    '-# ❌ Second · 1 tool',
  ]);
});

test('posts one message per job, throttles edits, and flushes the final state', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(STARTED_AT);
  const { publishDiscordDelegationStatus, sent, edit } = await importFresh();

  await publishDiscordDelegationStatus('channel-1', snapshot([entry()]));
  await publishDiscordDelegationStatus(
    'channel-1',
    snapshot([entry({ currentTool: 'web_search' })]),
  );
  await publishDiscordDelegationStatus(
    'channel-1',
    snapshot([entry({ currentTool: 'web_fetch', toolUses: 1 })]),
  );
  expect(sent).toHaveLength(1);
  expect(edit).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1_500);
  expect(edit).toHaveBeenCalledTimes(1);
  expect(edit.mock.calls[0]?.[0]).toEqual({
    content: expect.stringContaining('`web_fetch`'),
  });

  await publishDiscordDelegationStatus(
    'channel-1',
    snapshot([entry({ status: 'completed', toolUses: 2 })]),
  );
  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.calls[1]?.[0]).toEqual({
    content: '-# ✅ Research example.com · 2 tools · 1s',
  });
  expect(sent).toHaveLength(1);

  await publishDiscordDelegationStatus('channel-1', snapshot([entry()]));
  expect(sent).toHaveLength(2);
});

test('keeps separate messages for concurrent jobs', async () => {
  const { publishDiscordDelegationStatus, sent } = await importFresh();
  await publishDiscordDelegationStatus('channel-1', snapshot([entry()], 'a'));
  await publishDiscordDelegationStatus('channel-1', snapshot([entry()], 'b'));
  expect(sent).toHaveLength(2);
});
