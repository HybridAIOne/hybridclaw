import { describe, expect, test } from 'vitest';
import { HybridAIRequestError } from '../container/src/providers/shared.js';

describe('HybridAIRequestError', () => {
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
});
