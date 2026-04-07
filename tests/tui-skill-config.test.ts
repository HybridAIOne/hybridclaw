import { EventEmitter } from 'node:events';
import type readline from 'node:readline';

import { expect, test, vi } from 'vitest';

import { SKILL_CONFIG_CHANNEL_KINDS } from '../src/channels/channel.js';
import type { GatewayAdminSkillsResponse } from '../src/gateway/gateway-types.js';
import {
  collectTuiSkillConfigMutations,
  createTuiSkillConfigDraft,
  promptTuiSkillConfig,
  renderTuiSkillConfigLines,
  setTuiSkillEnabledInScope,
  TUI_SKILL_CONFIG_SCOPES,
} from '../src/tui-skill-config.js';

const PALETTE = {
  reset: '',
  bold: '',
  muted: '',
  teal: '',
  gold: '',
  green: '',
  red: '',
};

const ANSI_PALETTE = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  muted: '\x1b[90m',
  teal: '\x1b[36m',
  gold: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

function makeResponse(): GatewayAdminSkillsResponse {
  return {
    extraDirs: [],
    disabled: ['alpha'],
    channelDisabled: {
      discord: ['beta'],
      msteams: [],
      whatsapp: [],
      email: [],
    },
    skills: [
      {
        name: 'alpha',
        description: 'Alpha skill',
        category: 'apple',
        source: 'bundled',
        available: true,
        enabled: false,
        missing: [],
        userInvocable: true,
        disableModelInvocation: false,
        always: false,
        tags: [],
        relatedSkills: [],
      },
      {
        name: 'beta',
        description: 'Beta skill',
        category: 'office',
        source: 'bundled',
        available: true,
        enabled: true,
        missing: [],
        userInvocable: true,
        disableModelInvocation: false,
        always: false,
        tags: [],
        relatedSkills: [],
      },
      {
        name: 'gamma',
        description: 'Gamma skill',
        category: 'utility',
        source: 'workspace',
        available: false,
        enabled: true,
        missing: ['python3'],
        userInvocable: false,
        disableModelInvocation: false,
        always: false,
        tags: [],
        relatedSkills: [],
      },
    ],
  };
}

test('TUI_SKILL_CONFIG_SCOPES derives channel scopes from the shared config channel list', () => {
  expect(TUI_SKILL_CONFIG_SCOPES).toEqual([
    'global',
    ...SKILL_CONFIG_CHANNEL_KINDS,
  ]);
});

test('collectTuiSkillConfigMutations compares global and per-channel diffs', () => {
  const response = makeResponse();
  const draft = createTuiSkillConfigDraft(response);

  setTuiSkillEnabledInScope(draft, 'alpha', true, 'global');
  setTuiSkillEnabledInScope(draft, 'gamma', false, 'discord');

  expect(collectTuiSkillConfigMutations(response, draft)).toEqual([
    {
      name: 'alpha',
      enabled: true,
      channel: undefined,
    },
    {
      name: 'gamma',
      enabled: false,
      channel: 'discord',
    },
  ]);
});

test('renderTuiSkillConfigLines shows global override notes inside channel scopes', () => {
  const response = makeResponse();
  const draft = createTuiSkillConfigDraft(response);
  const rendered = renderTuiSkillConfigLines({
    response,
    draft,
    scope: 'discord',
    cursor: 0,
    scrollOffset: 0,
    width: 80,
    height: 12,
    palette: PALETTE,
  });

  expect(rendered.lines.join('\n')).toContain('[discord]');
  expect(rendered.lines.join('\n')).toContain('global disable still applies');
  expect(rendered.lines.join('\n')).toContain('missing: python3');
});

test('renderTuiSkillConfigLines wraps scope tabs so email remains visible on narrow terminals', () => {
  const response = makeResponse();
  const draft = createTuiSkillConfigDraft(response);
  const rendered = renderTuiSkillConfigLines({
    response,
    draft,
    scope: 'whatsapp',
    cursor: 0,
    scrollOffset: 0,
    width: 49,
    height: 12,
    palette: ANSI_PALETTE,
  });

  const scopeHeader = rendered.lines.slice(1, 3).join('\n');
  expect(scopeHeader).toContain('[whatsapp]');
  expect(scopeHeader).toContain('email');
});

test('promptTuiSkillConfig saves local toggles across multiple scopes', async () => {
  const response = makeResponse();
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 80,
    rows: 12,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;
  const rl = {
    line: '',
    cursor: 0,
    listeners: vi.fn((event: string) => {
      if (event === 'line' || event === 'SIGINT') return [];
      return [];
    }),
    on: vi.fn(),
    off: vi.fn(),
    prompt: vi.fn(),
  } as unknown as readline.Interface;
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });
  const saveMutation = vi.fn(async () => undefined);

  const prompt = promptTuiSkillConfig({
    rl,
    response,
    saveMutation,
    output,
    input,
  });

  input.emit('keypress', ' ', { name: 'space' });
  input.emit('keypress', '', { name: 'right' });
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', ' ', { name: 'space' });
  input.emit('keypress', '', { name: 'return' });

  await expect(prompt).resolves.toEqual({
    cancelled: false,
    savedCount: 2,
    changedScopeCount: 2,
  });
  expect(saveMutation.mock.calls.map(([mutation]) => mutation)).toEqual([
    {
      name: 'alpha',
      enabled: true,
      channel: undefined,
    },
    {
      name: 'beta',
      enabled: true,
      channel: 'discord',
    },
  ]);
  expect(writes.length).toBeGreaterThan(0);
});
