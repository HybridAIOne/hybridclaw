import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import {
  buildMessages,
  parseProposals,
} from '../plugins/proactive-assistant/src/assessment.js';
import {
  createFeed,
  isQuiet,
  wire,
} from '../plugins/proactive-assistant/src/feed.js';
import plugin from '../plugins/proactive-assistant/src/index.js';
import {
  CALENDAR_TOOL,
  ConnectorError,
  createPlatform,
  GMAIL_TOOL,
} from '../plugins/proactive-assistant/src/platform.js';
import { createStore } from '../plugins/proactive-assistant/src/store.js';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();
useCleanMocks({ restoreAllMocks: true, unstubAllEnvs: true });

const OWNER = { userId: 'user_a' };
const NOON = new Date('2026-09-30T12:00:00Z');
const MAIL = {
  source: 'gmail',
  text: 'New email\nFrom: Ben <ben@example.com>\nSubject: Contract draft',
};
const MEETING = {
  source: 'calendar',
  text: 'Upcoming calendar event\nTitle: Acme pitch',
};
const PROPOSAL = {
  event: 0,
  title: 'Reply to Ben about the contract',
  detail: 'Ben sent the contract draft.',
  why: 'He asked for an answer by Friday.',
  prompt: 'Draft a reply to Ben about the contract draft.',
};

interface Feed {
  settings: Record<string, unknown>;
  sources: Array<{ id: string; available: boolean }>;
  suggestions: Array<Record<string, string>>;
  last_checked_at: string | null;
  error: string | null;
  failure?: string;
}

function settings(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({ enabled: true, time_zone: 'UTC', ...overrides }),
  ).toString('base64url');
}

/** HybridAI as the feed sees it: the account, its connector tools, its phones. */
function fakePlatform() {
  const platform = {
    owner: OWNER.userId,
    tools: new Set([GMAIL_TOOL, CALENDAR_TOOL]),
    historyId: '100',
    mail: [] as Array<typeof MAIL>,
    meetings: [] as Array<typeof MEETING>,
    toolError: null as Error | null,
    pushResult: { delivered: true, reason: 'sent' },
    calls: [] as Array<{ name: string; args: Record<string, string> }>,
    pushes: [] as Array<Record<string, unknown>>,
    accountId: vi.fn(async () => platform.owner),
    toolNames: vi.fn(async () => platform.tools),
    async callTool(name: string, args: Record<string, string>) {
      platform.calls.push({ name, args });
      if (platform.toolError) throw platform.toolError;
      if (name === GMAIL_TOOL) {
        return { history_id: platform.historyId, events: platform.mail };
      }
      return {
        synced_at: '2026-09-30T12:00:00Z',
        horizon: '2026-10-01T12:00:00Z',
        events: platform.meetings,
      };
    },
    async push(notification: Record<string, unknown>) {
      platform.pushes.push(notification);
      return platform.pushResult;
    },
  };
  return platform;
}

function harness(homeDir = makeTempDir('hybridclaw-proactive-')) {
  const platform = fakePlatform();
  const clock = { now: NOON };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const assess = vi.fn(async (): Promise<string> => '[]');
  const onSwitchedOn = vi.fn();
  const feed = createFeed({
    store: createStore(homeDir, logger),
    platform,
    getApiKey: () => 'test-key',
    assess,
    assistantName: 'Ada',
    logger,
    onSwitchedOn,
    now: () => clock.now,
  });
  const run = async (...args: string[]): Promise<Feed> =>
    JSON.parse(await feed.command(args, OWNER));
  return { feed, run, platform, clock, assess, onSwitchedOn, logger, homeDir };
}

async function switchedOn(overrides: Record<string, unknown> = {}) {
  const context = harness();
  await context.run('configure', settings(overrides));
  // The first look only takes the bookmarks.
  await context.feed.check();
  context.platform.calls.length = 0;
  return context;
}

test('the feed starts switched off and says which sources could be watched', async () => {
  const { run, platform } = harness();
  platform.tools = new Set([GMAIL_TOOL]);

  const feed = await run('feed');

  expect(feed.settings).toMatchObject({ enabled: false, quiet_start: 22 });
  expect(feed.sources).toEqual([
    { id: 'gmail', available: true },
    { id: 'calendar', available: false },
  ]);
  expect(feed.suggestions).toEqual([]);
  // Nothing is read before the owner switches the feed on.
  expect(platform.calls).toEqual([]);
});

test.each([
  ['a workspace member', { userId: 'user_b' }, 'not_owner'],
  ['a caller without an identity', {}, 'not_owner'],
])('the feed is refused to %s', async (_label, context, failure) => {
  const { feed } = harness();

  expect(JSON.parse(await feed.command(['feed'], context))).toEqual({
    version: 1,
    failure,
  });
});

test('without a HybridAI credential the feed says so and reads nothing', async () => {
  const platform = fakePlatform();
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const feed = createFeed({
    store: createStore(makeTempDir('hybridclaw-proactive-'), logger),
    platform,
    getApiKey: () => '',
    assess: vi.fn(),
    assistantName: 'Ada',
    logger,
  });

  expect(JSON.parse(await feed.command(['feed'], OWNER)).failure).toBe(
    'not_signed_in',
  );
  expect(await feed.check()).toBe('not_signed_in');
  expect(platform.accountId).not.toHaveBeenCalled();
});

test.each([
  ['no switch', {}],
  ['a switch that is not a boolean', { enabled: 'yes' }],
  ['an hour past midnight', { enabled: true, quiet_start: 24 }],
  ['a fractional hour', { enabled: true, quiet_end: 7.5 }],
  ['an unknown time zone', { enabled: true, time_zone: 'Mars/Olympus' }],
  ['goals that are not text', { enabled: true, goals: ['win'] }],
  ['a language that is not a tag', { enabled: true, language: 'de; rm -rf' }],
])('settings with %s are refused and change nothing', async (_label, body) => {
  const { run, onSwitchedOn } = harness();
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');

  expect((await run('configure', encoded)).failure).toBe('invalid_settings');
  expect((await run('configure', 'not base64 json')).failure).toBe(
    'invalid_settings',
  );
  expect((await run('feed')).settings.enabled).toBe(false);
  expect(onSwitchedOn).not.toHaveBeenCalled();
});

test('switching on takes bookmarks first and passes them back on the next look', async () => {
  const { run, feed, platform, assess, onSwitchedOn } = harness();
  platform.mail = [MAIL];

  await run('configure', settings({ goals: ' Close the Acme deal ' }));
  expect(onSwitchedOn).toHaveBeenCalledOnce();
  expect(await feed.check()).toBe('checked');

  expect(platform.calls).toEqual([
    { name: GMAIL_TOOL, args: {} },
    { name: CALENDAR_TOOL, args: {} },
  ]);

  platform.calls.length = 0;
  platform.historyId = '140';
  await feed.check();

  expect(platform.calls).toEqual([
    { name: GMAIL_TOOL, args: { history_id: '100' } },
    {
      name: CALENDAR_TOOL,
      args: {
        synced_at: '2026-09-30T12:00:00Z',
        horizon: '2026-10-01T12:00:00Z',
      },
    },
  ]);
  expect(assess).toHaveBeenCalledTimes(2);
  expect((await run('feed')).settings.goals).toBe('Close the Acme deal');
});

test('an event becomes a suggestion, written once and announced by its title', async () => {
  const { run, feed, platform, assess } = await switchedOn({
    goals: 'Close the Acme deal',
    language: 'de-DE',
  });
  platform.mail = [MAIL];
  platform.meetings = [MEETING];
  // The model names the wrong source; the event it points at decides.
  assess.mockResolvedValueOnce(
    JSON.stringify([{ ...PROPOSAL, event: 1, source: 'gmail' }]),
  );

  expect(await feed.check()).toBe('checked');

  const [request] = assess.mock.calls.at(-1) as unknown as [
    Array<{ role: string; content: string }>,
  ];
  expect(request[0].role).toBe('system');
  expect(JSON.parse(request[1].content)).toMatchObject({
    language: 'de-DE',
    priorities: 'Close the Acme deal',
    events: [
      { index: 0, ...MAIL },
      { index: 1, ...MEETING },
    ],
    previous: [],
  });

  const { suggestions, last_checked_at, error } = await run('feed');
  expect(suggestions).toEqual([
    {
      id: expect.any(String),
      source: 'calendar',
      title: PROPOSAL.title,
      detail: PROPOSAL.detail,
      why: PROPOSAL.why,
      prompt: PROPOSAL.prompt,
      created_at: NOON.toISOString(),
    },
  ]);
  expect([last_checked_at, error]).toEqual([NOON.toISOString(), null]);
  expect(platform.pushes).toEqual([
    {
      id: `proactive:${suggestions[0].id}`,
      kind: 'proactive',
      title: 'Ada',
      body: PROPOSAL.title,
      data: { id: suggestions[0].id },
      badge: 1,
    },
  ]);

  // Nothing new: no model request, and the push is not repeated.
  platform.mail = [];
  platform.meetings = [];
  assess.mockClear();
  await feed.check();
  expect(assess).not.toHaveBeenCalled();
  expect(platform.pushes).toHaveLength(1);
});

test('only granted sources are read, and a lost one drops its cursor', async () => {
  const { feed, platform } = await switchedOn();
  platform.tools = new Set([CALENDAR_TOOL]);

  await feed.check();
  expect(platform.calls.map((call) => call.name)).toEqual([CALENDAR_TOOL]);

  // Granted again: the bookmark is taken anew instead of replaying the gap.
  platform.calls.length = 0;
  platform.tools = new Set([GMAIL_TOOL, CALENDAR_TOOL]);
  await feed.check();
  expect(platform.calls[0]).toEqual({ name: GMAIL_TOOL, args: {} });

  platform.calls.length = 0;
  platform.tools = new Set();
  expect(await feed.check()).toBe('not_connected');
  expect(platform.calls).toEqual([]);
});

test('quiet hours skip the look, and what was found at night is announced in the morning', async () => {
  const { run, feed, platform, clock, assess } = harness();
  clock.now = new Date('2026-09-30T23:00:00Z');
  platform.meetings = [MEETING];
  assess.mockResolvedValue(JSON.stringify([PROPOSAL]));

  // The first look runs even at night, but the phone stays silent.
  await run('configure', settings());
  expect(await feed.check()).toBe('checked');
  expect((await run('feed')).suggestions).toHaveLength(1);
  expect(platform.pushes).toEqual([]);

  platform.calls.length = 0;
  clock.now = new Date('2026-10-01T03:00:00Z');
  expect(await feed.check()).toBe('quiet');
  expect(platform.calls).toEqual([]);

  platform.meetings = [];
  clock.now = new Date('2026-10-01T08:00:00Z');
  expect(await feed.check()).toBe('checked');
  expect(platform.pushes).toHaveLength(1);
});

test.each([
  [
    'a dead connection',
    new ConnectorError('Google returned 401. Reconnect Google Workspace.'),
    'reconnect_google',
  ],
  [
    'an outage',
    new ConnectorError('Google API request failed (HTTP 500)'),
    'source_unavailable',
  ],
  ['an unreachable gateway', new Error('fetch failed'), 'source_unavailable'],
])('%s is reported and leaves the cursors alone', async (_label, error, code) => {
  const { run, feed, platform } = await switchedOn();
  platform.toolError = error;

  expect(await feed.check()).toBe('failed');
  expect((await run('feed')).error).toBe(code);

  platform.toolError = null;
  platform.calls.length = 0;
  await feed.check();
  expect(platform.calls[0].args).toEqual({ history_id: '100' });
  expect((await run('feed')).error).toBeNull();
});

test('events the model keeps failing on are passed over on the third try', async () => {
  const { run, feed, platform, assess, logger } = await switchedOn();
  platform.mail = [MAIL];
  platform.historyId = '140';
  assess.mockRejectedValue(new Error(`provider refused: ${MAIL.text}`));

  expect(await feed.check()).toBe('failed');
  expect(await feed.check()).toBe('failed');
  expect((await run('feed')).error).toBe('assessment_failed');
  expect(platform.calls.at(-2)?.args).toEqual({ history_id: '100' });

  expect(await feed.check()).toBe('checked');
  expect((await run('feed')).error).toBeNull();

  platform.calls.length = 0;
  await feed.check();
  expect(platform.calls[0].args).toEqual({ history_id: '140' });
  // A provider error can quote the mail it was asked about.
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Contract');
});

test('a settings change during a look discards what it found', async () => {
  const { run, feed, platform, assess } = await switchedOn();
  platform.mail = [MAIL];
  platform.historyId = '140';
  assess.mockImplementationOnce(async () => {
    await run('configure', settings({ goals: 'Something else' }));
    return JSON.stringify([PROPOSAL]);
  });

  expect(await feed.check()).toBe('superseded');

  expect((await run('feed')).suggestions).toEqual([]);
  expect(platform.pushes).toEqual([]);
  platform.calls.length = 0;
  await feed.check();
  expect(platform.calls[0].args).toEqual({ history_id: '100' });
});

test('switching off deletes the suggestions and starts over next time', async () => {
  const { run, feed, platform, assess } = await switchedOn();
  platform.mail = [MAIL];
  assess.mockResolvedValueOnce(JSON.stringify([PROPOSAL]));
  await feed.check();

  const off = await run('configure', settings({ enabled: false }));

  expect(off.suggestions).toEqual([]);
  expect(await feed.check()).toBe('disabled');

  platform.calls.length = 0;
  await run('configure', settings());
  await feed.check();
  expect(platform.calls[0].args).toEqual({});
  expect((await run('feed')).suggestions).toEqual([]);
});

test.each([
  'dismiss',
  'review',
])('%s closes a suggestion, and the model is told not to repeat it', async (operation) => {
  const { run, feed, platform, assess } = await switchedOn();
  platform.mail = [MAIL];
  assess.mockResolvedValueOnce(JSON.stringify([PROPOSAL]));
  await feed.check();
  const [open] = (await run('feed')).suggestions;

  expect((await run(operation, 'no-such-id')).failure).toBe('not_found');
  expect((await run(operation, open.id)).suggestions).toEqual([]);

  await feed.check();
  const [request] = assess.mock.calls.at(-1) as unknown as [
    Array<{ content: string }>,
  ];
  expect(JSON.parse(request[1].content).previous).toEqual([
    {
      title: PROPOSAL.title,
      status: operation === 'dismiss' ? 'dismissed' : 'reviewed',
    },
  ]);
});

test('an operation the feed does not know fails instead of reading the feed', async () => {
  const { run } = harness();

  expect((await run('delete-everything')).failure).toBe('unknown_operation');
  expect((await run('feed', 'extra', 'words')).failure).toBe(
    'unknown_operation',
  );
});

test('the feed resumes after a restart', async () => {
  const first = await switchedOn();
  first.platform.mail = [MAIL];
  first.assess.mockResolvedValueOnce(JSON.stringify([PROPOSAL]));
  await first.feed.check();

  const second = harness(first.homeDir);
  expect((await second.run('feed')).suggestions).toHaveLength(1);
  await second.feed.check();
  expect(second.platform.calls[0].args).toEqual({ history_id: '100' });
  // A restart asks once whose the credential is; the feed stays with that account.
  expect(second.platform.accountId).toHaveBeenCalledOnce();

  const state = path.join(first.homeDir, 'proactive-assistant', 'state.json');
  expect(fs.statSync(state).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(state, 'utf8')).not.toContain('test-key');
});

test('another account signing in does not inherit the feed', async () => {
  const first = await switchedOn();
  first.platform.mail = [MAIL];
  first.assess.mockResolvedValueOnce(JSON.stringify([PROPOSAL]));
  await first.feed.check();

  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const platform = fakePlatform();
  platform.owner = 'user_b';
  const feed = createFeed({
    store: createStore(first.homeDir, logger),
    platform,
    getApiKey: () => 'another-test-key',
    assess: vi.fn(),
    assistantName: 'Ada',
    logger,
  });

  const theirs = JSON.parse(await feed.command(['feed'], { userId: 'user_b' }));
  expect(theirs.settings.enabled).toBe(false);
  expect(theirs.suggestions).toEqual([]);
  expect(JSON.parse(await feed.command(['feed'], OWNER)).failure).toBe(
    'not_owner',
  );
});

test('a phone that registers late is still told, but not forever', async () => {
  const { feed, platform, assess } = await switchedOn();
  platform.mail = [MAIL];
  platform.pushResult = { delivered: false, reason: 'no_devices' };
  assess.mockResolvedValueOnce(JSON.stringify([PROPOSAL]));
  await feed.check();
  platform.mail = [];

  for (let attempt = 0; attempt < 20; attempt += 1) await feed.check();
  expect(platform.pushes).toHaveLength(12);

  platform.pushResult = { delivered: true, reason: 'sent' };
  await feed.check();
  expect(platform.pushes).toHaveLength(12);
});

test('a push the platform already delivered is not sent again', async () => {
  const { feed, platform, assess } = await switchedOn();
  platform.mail = [MAIL];
  platform.pushResult = { delivered: false, reason: 'duplicate' };
  assess.mockResolvedValueOnce(JSON.stringify([PROPOSAL]));
  await feed.check();
  platform.mail = [];

  await feed.check();

  expect(platform.pushes).toHaveLength(1);
});

test.each([
  ['not JSON', 'Sure! Here are my thoughts.', 0],
  ['an object instead of a list', JSON.stringify(PROPOSAL), 0],
  ['a fenced list', `\`\`\`json\n${JSON.stringify([PROPOSAL])}\n\`\`\``, 1],
  ['an event that does not exist', JSON.stringify([{ ...PROPOSAL, event: 2 }]), 0],
  ['a missing field', JSON.stringify([{ ...PROPOSAL, why: ' ' }]), 0],
  [
    'a field past its limit',
    JSON.stringify([{ ...PROPOSAL, title: 'x'.repeat(101) }]),
    0,
  ],
  ['more than three', JSON.stringify(Array(5).fill(PROPOSAL)), 3],
])('model output that is %s yields %i proposals', (_label, text, count) => {
  expect(parseProposals(text, 2)).toHaveLength(count);
});

test('the model is given the hour on the user’s clock', () => {
  const [, user] = buildMessages({
    now: NOON,
    settings: { goals: '', time_zone: 'Europe/Berlin' },
    language: 'en',
    events: [MAIL],
    previous: [],
  });

  expect(JSON.parse(user.content).now).toBe('2026-09-30 14:00 (Europe/Berlin)');
});

test.each([
  [22, 8, 'UTC', 23, true],
  [22, 8, 'UTC', 7, true],
  [22, 8, 'UTC', 8, false],
  [13, 15, 'UTC', 14, true],
  [13, 15, 'UTC', 15, false],
  [9, 9, 'UTC', 9, false],
  [22, 8, 'Europe/Berlin', 20, true],
])('quiet hours %i-%i in %s at %i:00 UTC: %s', (start, end, zone, hour, quiet) => {
  const moment = new Date(Date.UTC(2026, 8, 30, hour));

  expect(
    isQuiet({ quiet_start: start, quiet_end: end, time_zone: zone }, moment),
  ).toBe(quiet);
});

test('a reply survives the chat relay that carries it', () => {
  const value = { detail: 'Line one\nLine two\r', path: 'C:\\new\\report' };
  const sent = wire(value);

  // What a relay's client does to every chunk of chat text.
  const received = sent.replaceAll('\\n', '\n').replaceAll('\\r', '\r');

  expect(sent).not.toMatch(/\\[nr\\]/);
  expect(JSON.parse(received)).toEqual(value);
});

test('the platform client asks HybridAI with the gateway credential', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const answers: Record<string, unknown> = {
    '/v1/app-config': { user: { user_id: 'user_a' } },
    '/v1/push': { delivered: true, reason: 'sent' },
  };
  const platform = createPlatform({
    baseUrl: 'https://hybridai.example.com/',
    getApiKey: () => 'test-key',
    fetchImpl: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const { pathname } = new URL(url);
      const body = init.body ? JSON.parse(String(init.body)) : null;
      const answer =
        answers[pathname] ??
        (body.method === 'tools/list'
          ? { result: { tools: [{ name: GMAIL_TOOL }] } }
          : body.params.name === GMAIL_TOOL
            ? {
                result: {
                  content: [{ type: 'text', text: '{"history_id":"7"}' }],
                  isError: false,
                },
              }
            : {
                result: {
                  content: [{ type: 'text', text: 'Reconnect it.' }],
                  isError: true,
                },
              });
      return new Response(JSON.stringify(answer), { status: 200 });
    },
  });

  expect(await platform.accountId()).toBe('user_a');
  expect([...(await platform.toolNames())]).toEqual([GMAIL_TOOL]);
  expect(await platform.callTool(GMAIL_TOOL, {})).toEqual({ history_id: '7' });
  await expect(platform.callTool(CALENDAR_TOOL, {})).rejects.toMatchObject({
    reconnect: true,
  });
  expect(await platform.push({ id: 'n1' })).toEqual({
    delivered: true,
    reason: 'sent',
  });

  expect(new Set(requests.map(({ url }) => new URL(url).origin))).toEqual(
    new Set(['https://hybridai.example.com']),
  );
  for (const { init } of requests) {
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer test-key',
    );
  }
});

test('the plugin registers the app’s command and a watch it can stop', async () => {
  vi.useFakeTimers();
  const api = {
    config: { hybridai: { baseUrl: 'https://hybridai.example.com' } },
    runtime: { homeDir: makeTempDir('hybridclaw-proactive-') },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    getCredential: vi.fn(() => undefined),
    callAuxiliaryModel: vi.fn(),
    registerCommand: vi.fn(),
    registerService: vi.fn(),
  };

  plugin.register(api as never);

  const command = api.registerCommand.mock.calls[0][0];
  expect(command.name).toBe('proactive');
  expect(JSON.parse(await command.handler(['feed'], OWNER)).failure).toBe(
    'not_signed_in',
  );

  const service = api.registerService.mock.calls[0][0];
  await service.start();
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(api.getCredential).toHaveBeenCalledTimes(2);
  await service.stop();
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(api.getCredential).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test('the bundled plugin loads once it is enabled in config', async () => {
  const homeDir = makeTempDir('hybridclaw-proactive-home-');
  const cwd = makeTempDir('hybridclaw-proactive-project-');
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.plugins.list = [{ id: 'proactive-assistant', enabled: true, config: {} }];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'proactive-assistant',
      status: 'loaded',
      candidate: expect.objectContaining({ source: 'bundled' }),
    }),
  ]);
  expect(manager.findCommand('proactive')).toBeDefined();
  await manager.shutdown?.();
});
