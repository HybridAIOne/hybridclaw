import { describe, expect, it } from 'vitest';
import type { ChatModel } from '../../api/types';
import { parseModel } from './model-switch-select';

function model(overrides: Partial<ChatModel> & Pick<ChatModel, 'id'>): ChatModel {
  return {
    backend: null,
    contextWindow: null,
    isReasoning: false,
    family: null,
    parameterSize: null,
    provider: 'hybridai',
    ...overrides,
  };
}

describe('parseModel', () => {
  it('groups bare-slug HybridAI default under "HybridAI · OpenAI", not Local', () => {
    // Regression guard: `gpt-4.1-mini` (the gateway-default HybridAI passthrough)
    // used to bucket under "Local · OpenAI" before the catalog rows started
    // carrying an explicit `provider` tag.
    const parsed = parseModel(model({ id: 'gpt-4.1-mini', provider: 'hybridai' }));
    expect(parsed.groupLabel).toBe('HybridAI · OpenAI');
    expect(parsed.displayName).toBe('GPT-4.1 Mini');
  });

  it('routes Ollama-tagged bare slugs to the Ollama group', () => {
    const parsed = parseModel(
      model({ id: 'llama-3.1', provider: 'ollama', backend: 'ollama' }),
    );
    expect(parsed.groupLabel).toBe('Ollama · Meta');
  });

  it('uses the prefix for two-segment ids and ignores entry.provider', () => {
    const parsed = parseModel(
      model({ id: 'openai-codex/gpt-5.4', provider: 'codex' }),
    );
    expect(parsed.groupLabel).toBe('OpenAI Codex · OpenAI');
    expect(parsed.displayName).toBe('GPT-5.4');
  });

  it('parses three-segment ids as provider · vendor · model', () => {
    const parsed = parseModel(
      model({
        id: 'hybridai/anthropic/claude-haiku-4-5',
        provider: 'hybridai',
      }),
    );
    expect(parsed.groupLabel).toBe('HybridAI · Anthropic');
    expect(parsed.displayName).toBe('Claude Haiku 4.5');
  });
});
