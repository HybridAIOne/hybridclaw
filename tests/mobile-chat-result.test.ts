import { describe, expect, it } from 'vitest';
import type { GatewayChatResult } from '../src/gateway/gateway-types.js';
import { chatResultForClient } from '../src/gateway/mobile-chat-result.js';

// Shaped like a measured phone turn: one `skills_list` call, then a short reply.
function skillsListTurn(): GatewayChatResult {
  const skills = Array.from({ length: 71 }, (_, index) => ({
    name: `skill-${index}`,
    description:
      `Example skill ${index} that does one thing for the agent. `.repeat(4),
    category: 'development',
    path: `/workspace/skills/skill-${index}/SKILL.md`,
  }));
  return {
    status: 'success',
    result: 'You have 71 skills; the newest one is skill-70 now.',
    messageRole: 'assistant',
    toolsUsed: ['skills_list'],
    outputPresentation: {
      segmentKind: 'final',
      visible: true,
      displaySurface: 'assistant_bubble',
    },
    pluginsUsed: [],
    agentId: 'main',
    model: 'hybridai/gpt-5-mini',
    provider: 'hybridai',
    memoryAccess: {
      semanticRecallAttempted: true,
      summaryIncluded: true,
      recalledMemories: [1, 2, 3].map((memoryId) => ({
        ref: `[mem:${memoryId}]`,
        memoryId,
        content:
          'The user prefers short answers and works on the agent. '.repeat(3),
        confidence: 0.8,
      })),
    },
    toolExecutions: [
      {
        name: 'skills_list',
        arguments: JSON.stringify({ query: '' }),
        result: JSON.stringify({ skills }),
        toolCallId: 'call_1',
        durationMs: 42,
        approvalTier: 'green',
        approvalDecision: 'auto',
      },
    ],
    tokenUsage: {
      modelCalls: 2,
      apiUsageAvailable: true,
      apiPromptTokens: 24_000,
      apiCompletionTokens: 120,
      apiTotalTokens: 24_120,
      apiCacheUsageAvailable: true,
      apiCacheReadTokens: 18_000,
      apiCacheWriteTokens: 0,
      estimatedPromptTokens: 23_800,
      estimatedCompletionTokens: 118,
      estimatedTotalTokens: 23_918,
      performanceSamples: [
        {
          durationMs: 1800,
          promptTokens: 11_900,
          completionTokens: 40,
          totalTokens: 11_940,
        },
        {
          durationMs: 2100,
          promptTokens: 12_100,
          completionTokens: 80,
          totalTokens: 12_180,
        },
      ],
    },
    effectiveUserPrompt: 'Which skills do I have?',
    assistantPresentation: { agentId: 'main', displayName: 'Hy' },
    sessionId: 'agent:main:channel:web:chat:dm:peer:phone',
    sessionKey: 'agent:main:channel:web:chat:dm:peer:phone',
    mainSessionKey: 'agent:main:main',
    userMessageId: 41,
    assistantMessageId: 42,
  };
}

function resultLine(result: GatewayChatResult): string {
  return `${JSON.stringify({ type: 'result', result })}\n`;
}

describe('chatResultForClient', () => {
  it('leaves the result of every other client as it is', () => {
    const result = skillsListTurn();
    expect(chatResultForClient(undefined, result)).toBe(result);
  });

  it.each([
    'toolExecutions',
    'tokenUsage',
    'effectiveUserPrompt',
    'memoryAccess',
    'model',
    'provider',
    'sessionKey',
  ] as const)('drops %s for the phone', (field) => {
    const result = skillsListTurn();
    expect(result[field]).toBeDefined();
    expect(chatResultForClient('mobile', result)).not.toHaveProperty(field);
  });

  it.each([
    ['a reply', skillsListTurn()],
    [
      'a reply with files',
      {
        ...skillsListTurn(),
        artifacts: [
          {
            path: '/workspace/out/report.pdf',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
          },
        ],
      },
    ],
    [
      'the first reply of a new chat',
      { ...skillsListTurn(), sessionTitle: 'Weekend Trip Plan' },
    ],
    [
      'a failed turn',
      {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: 'Model call failed.',
        assistantMessageId: 7,
      },
    ],
  ] satisfies [string, GatewayChatResult][])(
    'keeps every field the apps read from %s',
    (_, result) => {
      const read = [
        'status',
        'result',
        'error',
        'userMessageId',
        'assistantMessageId',
        'artifacts',
        'sessionTitle',
      ] as const;
      const slim = chatResultForClient('mobile', result);
      for (const field of read) expect(slim[field]).toEqual(result[field]);
      expect(slim.sessionId).toBe(result.sessionId);
      expect(slim.toolsUsed).toEqual(result.toolsUsed);
    },
  );

  it('gives the phone the turn cost and an estimate as they are', () => {
    const cost = { eur: 0.0123, free: false, requests: 3 };
    const costEstimate = { low: 0.2, high: 0.5, free: false, requests: 20 };
    const slim = chatResultForClient('mobile', {
      ...skillsListTurn(),
      cost,
      costEstimate,
    });
    expect(slim.cost).toEqual(cost);
    expect(slim.costEstimate).toEqual(costEstimate);
    expect(chatResultForClient('mobile', skillsListTurn())).not.toHaveProperty(
      'cost',
    );
  });

  it('sends the phone a result line without tool outputs', () => {
    const result = skillsListTurn();
    const full = resultLine(result);
    const slim = resultLine(chatResultForClient('mobile', result));

    expect(full.length).toBeGreaterThan(20_000);
    expect(slim.length).toBeLessThan(400);
    expect(slim).not.toContain('skill-0');
  });

  it('keeps the receipt, which the phone shows beside the reply', () => {
    const receipt = {
      version: 1 as const,
      more: 0,
      items: [
        {
          kind: 'read' as const,
          tool: 'skills_list',
          service: null,
          target: 'skills',
          to: [],
          count: 1,
          ok: true,
          blocked: false,
          error: null,
          proof: null,
        },
      ],
    };
    const slim = chatResultForClient('mobile', {
      ...skillsListTurn(),
      receipt,
    });
    expect(slim.receipt).toEqual(receipt);
    expect(chatResultForClient('mobile', skillsListTurn())).not.toHaveProperty(
      'receipt',
    );
  });
});
