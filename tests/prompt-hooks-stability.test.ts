import { expect, test, vi } from 'vitest';

import {
  buildConversationContext,
  buildDynamicContextMessage,
} from '../src/agent/conversation.js';
import { buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';

test('buildSystemPromptFromHooks is byte-stable across same-date turns', () => {
  vi.useFakeTimers();

  try {
    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
    const firstPrompt = buildSystemPromptFromHooks({
      agentId: 'canonical-agent',
      skills: [],
      runtimeInfo: {
        model: 'openai-codex/gpt-5.4',
        channelType: 'discord',
        channelId: 'channel-1',
        guildId: 'guild-1',
        workspacePath: '/workspace/canonical-agent',
      },
    });

    vi.setSystemTime(new Date('2026-05-13T12:01:00.000Z'));
    const secondPrompt = buildSystemPromptFromHooks({
      agentId: 'canonical-agent',
      skills: [],
      runtimeInfo: {
        model: 'openai-codex/gpt-5.4',
        channelType: 'discord',
        channelId: 'channel-1',
        guildId: 'guild-1',
        workspacePath: '/workspace/canonical-agent',
      },
    });

    expect(secondPrompt).toBe(firstPrompt);
    expect(firstPrompt).not.toContain('Date (UTC):');
    expect(firstPrompt).not.toContain('Host:');
  } finally {
    vi.useRealTimers();
  }
});

test('buildConversationContext appends dynamic context before history', () => {
  vi.useFakeTimers();

  try {
    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
    const context = buildConversationContext({
      agentId: 'canonical-agent',
      history: [{ role: 'user', content: 'Hello' }],
      runtimeInfo: {
        model: 'openai-codex/gpt-5.4',
        workspacePath: '/workspace/canonical-agent',
      },
    });

    expect(context.messages[0]?.role).toBe('system');
    expect(context.messages[0]?.content).not.toContain('Date (UTC):');
    expect(context.messages[1]).toEqual(buildDynamicContextMessage());
    expect(context.messages[1]?.content).toContain('Date (UTC): 2026-05-13');
    expect(context.messages[2]).toEqual({ role: 'user', content: 'Hello' });
  } finally {
    vi.useRealTimers();
  }
});
