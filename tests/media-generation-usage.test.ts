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
              cost_usd: 0.1234,
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
        costUsd: 0.1234,
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

  test('uses exact xAI image request cost when returned by the API', () => {
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
            usage: { generated_images: 1, cost_usd: 0.0397 },
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
        costUsd: 0.0397,
      }),
    );
  });

  test('uses exact BFL request credits when returned by the API', () => {
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
            provider: 'bfl',
            model: 'flux-2-pro-preview',
            images: [{ path: '/workspace/.generated-images/image.png' }],
            usage: { generated_images: 1, cost_credits: 4.5, cost_usd: 0.045 },
          }),
          durationMs: 100,
        },
      ],
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        model: 'bfl/flux-2-pro-preview',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0.045,
      }),
    );
  });

  test('builds an audio transcription usage event from duration and cost', () => {
    const events = buildMediaGenerationUsageEvents({
      sessionId: 'session-1',
      agentId: 'agent-1',
      auditRunId: 'run-1',
      toolExecutions: [
        {
          name: 'audio_transcribe',
          arguments: '{}',
          result: JSON.stringify({
            success: true,
            provider: 'openai',
            model: 'whisper-1',
            text: 'Hello world.',
            duration_sec: 12.5,
            cost_usd: 0.00125,
          }),
          durationMs: 100,
        },
      ],
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        model: 'openai/whisper-1',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0.00125,
      }),
    );
  });

  test('estimates non-OpenAI audio transcription cost when provider omits it', () => {
    const events = buildMediaGenerationUsageEvents({
      sessionId: 'session-1',
      agentId: 'agent-1',
      auditRunId: 'run-1',
      toolExecutions: [
        {
          name: 'audio_transcribe',
          arguments: '{}',
          result: JSON.stringify({
            success: true,
            provider: 'assemblyai',
            model: 'universal',
            text: 'Hello world.',
            duration_sec: 60,
          }),
          durationMs: 100,
        },
      ],
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        model: 'assemblyai/universal',
        costUsd: 0.0035,
      }),
    );
  });
});
