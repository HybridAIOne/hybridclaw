import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import {
  compactConversation,
  splitConversation,
} from '../src/memory/compaction.js';
import { listArchives } from '../src/memory/compaction-archive.js';
import type { Session, StoredMessage } from '../src/types.js';

function makeSession(partial?: Partial<Session>): Session {
  return {
    id: 'session:compact',
    guild_id: null,
    channel_id: 'channel:compact',
    agent_id: 'main',
    chatbot_id: 'bot-1',
    model: 'gpt-5-nano',
    enable_rag: 1,
    message_count: 0,
    session_summary: '## Goals\n- Existing durable context.\n',
    summary_updated_at: null,
    compaction_count: 0,
    memory_flush_at: null,
    full_auto_enabled: 0,
    full_auto_prompt: null,
    full_auto_started_at: null,
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    ...(partial || {}),
  };
}

function makeMessage(
  id: number,
  role: StoredMessage['role'],
  content: string,
): StoredMessage {
  return {
    id,
    session_id: 'session:compact',
    user_id: role === 'assistant' ? 'assistant' : 'user',
    username: role === 'assistant' ? null : 'user',
    role,
    content,
    created_at: new Date(1_700_000_000_000 + id * 1_000).toISOString(),
  };
}

function makeStructuredSummary(label: string): string {
  return [
    '## Goals',
    `- ${label} goals`,
    '',
    '## Constraints',
    '- Keep identifiers exact.',
    '',
    '## Progress',
    `- ${label} progress`,
    '',
    '## Key Decisions',
    `- ${label} decisions`,
    '',
    '## Next Steps',
    `- ${label} next steps`,
    '',
    '## Key Context',
    `- ${label} context`,
  ].join('\n');
}

describe('memory compaction', () => {
  test('splitConversation preserves system messages and a recent tail', () => {
    const messages = [
      makeMessage(1, 'system', 'System instruction'),
      makeMessage(2, 'user', 'User asks for a release plan'),
      makeMessage(3, 'assistant', 'Assistant outlines the first plan'),
      makeMessage(4, 'user', 'User adds a deadline and team size'),
      makeMessage(5, 'assistant', 'Assistant revises the plan'),
      makeMessage(6, 'user', 'User asks for risk tracking'),
      makeMessage(7, 'assistant', 'Assistant adds risks and owners'),
    ];

    const split = splitConversation(messages, {
      keepRecentMessages: 3,
      compactRatio: 0.7,
    });

    expect(split.system.map((message) => message.id)).toEqual([1]);
    expect(split.compactable.length).toBeGreaterThan(0);
    expect(split.recent.length).toBeGreaterThanOrEqual(3);
    expect(split.recent.at(-1)?.id).toBe(7);
  });

  test('compactConversation archives transcript, stores semantic memory, and deletes only compacted messages', async () => {
    const archiveBaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-compact-'),
    );
    const detail = 'Include dates, owners, risks, and dependencies. '.repeat(
      12,
    );
    const messages = [
      makeMessage(1, 'user', `Kick off release planning. ${detail}`),
      makeMessage(2, 'assistant', `Drafting the first release plan. ${detail}`),
      makeMessage(3, 'user', `Need dates, owners, and blockers. ${detail}`),
      makeMessage(4, 'assistant', `Adding dates and owners now. ${detail}`),
      makeMessage(
        5,
        'user',
        `Also keep recent context available for follow-up work. ${detail}`,
      ),
      makeMessage(
        6,
        'assistant',
        `Recent context will remain preserved after compaction. ${detail}`,
      ),
    ];

    const storedSemantic: Array<Record<string, unknown>> = [];
    const updatedSummaries: string[] = [];
    const deletedIds: number[][] = [];
    const result = await compactConversation({
      session: makeSession(),
      messages,
      backend: {
        deleteMessagesByIds: (_sessionId, ids) => {
          deletedIds.push([...ids]);
          return ids.length;
        },
        storeSemanticMemory: (params) => {
          storedSemantic.push(params as Record<string, unknown>);
          return 1;
        },
        updateSessionSummary: (_sessionId, summary) => {
          updatedSummaries.push(summary);
        },
      },
      promptRunner: {
        run: async () => makeStructuredSummary('single-stage'),
      },
      embed: () => [0.5, 0.5],
      config: {
        archiveBaseDir,
        keepRecentMessages: 2,
        compactRatio: 0.7,
      },
    });

    expect(result.archivePath.startsWith(archiveBaseDir)).toBe(true);
    expect(fs.existsSync(result.archivePath)).toBe(true);
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.messagesPreserved).toBeGreaterThanOrEqual(2);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(storedSemantic).toHaveLength(1);
    expect(storedSemantic[0]?.source).toBe('compaction');
    expect(storedSemantic[0]?.scope).toBe('session');
    expect(storedSemantic[0]?.confidence).toBe(0.95);
    expect(updatedSummaries[0]).toContain('## Goals');
    expect(deletedIds[0]?.length).toBe(result.messagesCompacted);

    const archives = listArchives('session:compact', archiveBaseDir);
    expect(archives).toHaveLength(1);
    expect(archives[0]?.path).toBe(result.archivePath);
  });

  test('compactConversation uses multi-stage summarization for large histories', async () => {
    const archiveBaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-compact-stages-'),
    );
    const largeBody = 'x'.repeat(4_800);
    const messages = Array.from({ length: 80 }, (_, index) =>
      makeMessage(
        index + 1,
        index % 2 === 0 ? 'user' : 'assistant',
        `Message ${index + 1}: ${largeBody}`,
      ),
    );
    const stageKinds: string[] = [];

    const result = await compactConversation({
      session: makeSession(),
      messages,
      backend: {
        deleteMessagesByIds: (_sessionId, ids) => ids.length,
        storeSemanticMemory: () => 1,
        updateSessionSummary: () => {},
      },
      promptRunner: {
        run: async ({ stageKind, stageIndex }) => {
          stageKinds.push(`${stageKind}:${stageIndex}`);
          return makeStructuredSummary(`${stageKind}-${stageIndex}`);
        },
      },
      config: {
        archiveBaseDir,
        keepRecentMessages: 3,
        compactRatio: 0.7,
      },
    });

    expect(result.stages.some((stage) => stage.kind === 'part')).toBe(true);
    expect(result.stages.some((stage) => stage.kind === 'merge')).toBe(true);
    expect(stageKinds.some((stage) => stage.startsWith('part:'))).toBe(true);
    expect(stageKinds.some((stage) => stage.startsWith('merge:'))).toBe(true);
  });
});
