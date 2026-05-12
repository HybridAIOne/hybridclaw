import { describe, expect, test } from 'vitest';

import { buildMediaGenerationUsageEvents } from '../src/usage/media-generation-usage.js';

describe('media generation usage accounting', () => {
  test('builds an image model usage event from provider token usage', () => {
    const events = buildMediaGenerationUsageEvents({
      sessionId: 'session-1',
      agentId: 'agent-1',
      auditRunId: 'run-1',
      toolExecutions: [
        {
          name: 'image_generate',
          arguments: '{}',
          result: JSON.stringify({
            success: true,
            provider: 'openai',
            model: 'gpt-image-2',
            images: [{ path: '/workspace/.generated-images/image.png' }],
            usage: {
              input_tokens: 12,
              output_tokens: 1120,
              total_tokens: 1132,
              generated_images: 1,
            },
          }),
          durationMs: 100,
        },
      ],
    });

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        agentId: 'agent-1',
        auditRunId: 'run-1',
        model: 'openai/gpt-image-2',
        inputTokens: 12,
        outputTokens: 1120,
        totalTokens: 1132,
        toolCalls: 0,
      }),
    ]);
  });

  test('estimates Gemini image output token usage for usage rollups', () => {
    const events = buildMediaGenerationUsageEvents({
      sessionId: 'session-1',
      agentId: 'agent-1',
      auditRunId: 'run-1',
      toolExecutions: [
        {
          name: 'image_generate',
          arguments: '{}',
          result: JSON.stringify({
            success: true,
            provider: 'gemini',
            model: 'gemini-3.1-flash-image-preview',
            images: [{ path: '/workspace/.generated-images/image.png' }],
            usage: {
              output_tokens: 1120,
              total_tokens: 1120,
              output_image_tokens: 1120,
              generated_images: 1,
              estimated: true,
            },
          }),
          durationMs: 100,
        },
      ],
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        model: 'gemini/gemini-3.1-flash-image-preview',
        inputTokens: 0,
        outputTokens: 1120,
        totalTokens: 1120,
        costUsd: 0.0672,
      }),
    );
  });

  test('records flat-price image providers as separate zero-token usage rows', () => {
    const events = buildMediaGenerationUsageEvents({
      sessionId: 'session-1',
      agentId: 'agent-1',
      auditRunId: 'run-1',
      toolExecutions: [
        {
          name: 'image_generate',
          arguments: '{}',
          result: JSON.stringify({
            success: true,
            provider: 'xai',
            model: 'grok-imagine-image-quality',
            images: [{ path: '/workspace/.generated-images/image.png' }],
            usage: { generated_images: 1 },
          }),
          durationMs: 100,
        },
      ],
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        model: 'xai/grok-imagine-image-quality',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0.04,
      }),
    );
  });
});
