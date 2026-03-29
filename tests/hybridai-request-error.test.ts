import { describe, expect, test } from 'vitest';
import {
  HybridAIRequestError,
  isHybridAIEmptyVisibleCompletion,
  summarizeHybridAICompletionForDebug,
} from '../container/src/providers/shared.js';

describe('HybridAIRequestError', () => {
  test('rewrites premium-model permission errors into an actionable message', () => {
    const error = new HybridAIRequestError(
      403,
      JSON.stringify({
        error: {
          message:
            'Premium models require a paid plan or token-credit balance.',
          type: 'permission_error',
          code: 403,
        },
      }),
    );

    expect(error.message).toBe(
      'HybridAI API error 403: Premium model access requires a paid plan or token-credit balance. The non-premium HybridAI model is `gpt-4.1-mini`; use `/model set gpt-4.1-mini`, add credits, or switch to a configured `huggingface/...`, `openrouter/...`, or `openai-codex/...` model.',
    );
  });

  test('formats nested JSON error bodies with only the extracted message', () => {
    const error = new HybridAIRequestError(
      500,
      JSON.stringify({
        error: {
          code: 500,
          message: 'An error occurred while processing your request',
          type: 'server_error',
        },
      }),
    );

    expect(error.message).toBe(
      'HybridAI API error 500: An error occurred while processing your request',
    );
  });

  test('preserves the original response body for debugging', () => {
    const body = JSON.stringify({
      error: {
        code: 500,
        message: 'An error occurred while processing your request',
        type: 'server_error',
      },
    });
    const error = new HybridAIRequestError(500, body);

    expect(error.body).toBe(body);
  });

  test('caches the parsed provider error body on the request error', () => {
    const error = new HybridAIRequestError(
      403,
      JSON.stringify({
        error: {
          message:
            'Premium models require a paid plan or token-credit balance.',
          type: 'permission_error',
        },
      }),
    );

    expect(error.parsedBody).toEqual({
      message: 'Premium models require a paid plan or token-credit balance.',
      type: 'permission_error',
    });
  });
});

describe('HybridAI empty completion guard', () => {
  test('detects a success payload with no visible text and no tool calls', () => {
    expect(
      isHybridAIEmptyVisibleCompletion({
        id: 'resp_empty',
        model: 'gpt-5-nano',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4096,
          total_tokens: 4106,
        },
      }),
    ).toBe(true);
  });

  test('does not flag visible text or tool calls as empty completions', () => {
    expect(
      isHybridAIEmptyVisibleCompletion({
        id: 'resp_text',
        model: 'gpt-5-nano',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Done.',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    ).toBe(false);
    expect(
      isHybridAIEmptyVisibleCompletion({
        id: 'resp_tool',
        model: 'gpt-5-nano',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: '{"command":"pwd"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ).toBe(false);
  });

  test('summarizes the empty completion shape for debug logging', () => {
    expect(
      summarizeHybridAICompletionForDebug({
        id: 'resp_empty',
        model: 'gpt-5-nano',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4096,
          total_tokens: 4106,
        },
      }),
    ).toBe(
      'id=resp_empty model=gpt-5-nano finish=stop contentType=null',
    );
  });
});
