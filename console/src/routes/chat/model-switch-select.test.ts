import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatModel } from '../../api/types';
import { ModelSwitchSelect, parseModel } from './model-switch-select';

function model(
  overrides: Partial<ChatModel> & Pick<ChatModel, 'id'>,
): ChatModel {
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
    const parsed = parseModel(
      model({ id: 'gpt-4.1-mini', provider: 'hybridai' }),
    );
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

  it('groups named vLLM endpoint ids under the vLLM rail provider', () => {
    const parsed = parseModel(
      model({
        id: 'haigpu2/google/gemma-4-e4b-it',
        provider: 'vllm',
        backend: 'vllm',
      }),
    );
    expect(parsed.provider).toBe('vLLM');
    expect(parsed.groupLabel).toBe('vLLM · Google');
    expect(parsed.routeLabel).toBe('haigpu2');
    expect(parsed.displayName).toBe('Gemma 4 E4b It');
  });

  it('keeps the default vLLM backend route visible', () => {
    const parsed = parseModel(
      model({
        id: 'vllm/Qwen/Qwen3.6-27B-FP8',
        provider: 'vllm',
        backend: 'vllm',
      }),
    );
    expect(parsed.routeLabel).toBe('vLLM');
  });

  it('strips Anthropic date-stamp suffixes from displayName', () => {
    const parsed = parseModel(
      model({
        id: 'hybridai/anthropic/claude-opus-4-1-20250805',
        provider: 'hybridai',
      }),
    );
    expect(parsed.displayName).toBe('Claude Opus 4.1');
  });

  it('renders the selected runtime model even when it is missing from the catalog', () => {
    render(
      createElement(ModelSwitchSelect, {
        models: [
          model({
            id: 'hybridai/qwen3.6-27b-fp8',
            provider: 'hybridai',
          }),
        ],
        selectedModelId: 'hybridai/grok-4.20-0309-non-reasoning',
        onSwitch: vi.fn(),
      }),
    );

    const trigger = screen.getByRole('combobox', { name: 'Switch model' });
    expect(trigger.textContent).toContain('Grok 4.20 0309 Non Reasoning');
    expect(trigger.textContent).not.toContain('Qwen3.6 27b Fp8');
  });

  it('disambiguates duplicate local model names by route in the dropdown', () => {
    render(
      createElement(ModelSwitchSelect, {
        models: [
          model({
            id: 'vllm/Qwen/Qwen3.6-27B-FP8',
            provider: 'vllm',
            backend: 'vllm',
            contextWindow: 131_072,
          }),
          model({
            id: 'haigpu1/Qwen/Qwen3.6-27B-FP8',
            provider: 'vllm',
            backend: 'vllm',
            contextWindow: 131_072,
          }),
        ],
        selectedModelId: 'vllm/Qwen/Qwen3.6-27B-FP8',
        onSwitch: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Switch model' }));

    const defaultRoute = document.querySelector<HTMLElement>(
      '[data-value="vllm/Qwen/Qwen3.6-27B-FP8"]',
    );
    const namedRoute = document.querySelector<HTMLElement>(
      '[data-value="haigpu1/Qwen/Qwen3.6-27B-FP8"]',
    );
    expect(defaultRoute?.textContent).toContain('vLLM');
    expect(defaultRoute?.getAttribute('aria-label')).toContain('vLLM');
    expect(namedRoute?.textContent).toContain('haigpu1');
    expect(namedRoute?.getAttribute('aria-label')).toContain('haigpu1');
  });
});
