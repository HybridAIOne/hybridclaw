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

  it('labels automatic routing and lets the displayed default be explicitly pinned', () => {
    const onSwitch = vi.fn();
    render(
      createElement(ModelSwitchSelect, {
        models: [
          model({
            id: 'openai-codex/gpt-5.6-luna',
            provider: 'codex',
          }),
          model({
            id: 'haigpu2/google/gemma-4-e4b-it',
            provider: 'vllm',
            backend: 'vllm',
          }),
        ],
        selectedModelId: 'openai-codex/gpt-5.6-luna',
        routing: {
          active: true,
          startTier: 'economy',
          startModel: 'haigpu2/google/gemma-4-e4b-it',
        },
        onSwitch,
      }),
    );

    const trigger = screen.getByRole('combobox', {
      name: 'Switch model, automatic routing active',
    });
    expect(trigger.textContent).toContain('Auto · Economy');
    expect(trigger.title).toContain('Starts at Economy with Gemma 4 E4b It');

    fireEvent.click(trigger);
    expect(
      screen.getByText(/Automatic routing is active/).textContent,
    ).toContain('Select a model to pin this chat.');
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-value="openai-codex/gpt-5.6-luna"]',
      ) as HTMLElement,
    );

    expect(onSwitch).toHaveBeenCalledWith('openai-codex/gpt-5.6-luna');
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

describe('local model highlighting', () => {
  const entries = [
    model({ id: 'gpt-5', provider: 'hybridai', zone: 'cloud' }),
    model({
      id: 'gpu/qwen-27b',
      provider: 'vllm',
      backend: 'vllm',
      zone: 'hai',
    }),
    model({ id: 'mac-mlx/spark-x2.5-4b', provider: 'mlx', zone: 'local' }),
    model({
      id: 'ollama/llama-3.1',
      provider: 'ollama',
      backend: 'ollama',
      zone: 'local',
    }),
  ];
  it('highlights local destinations, lists them first, and offers a Local filter', () => {
    const onSwitch = vi.fn();
    render(
      createElement(ModelSwitchSelect, {
        models: entries,
        selectedModelId: 'gpt-5',
        onSwitch,
      }),
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Switch model' }));
    const options = screen.getAllByRole('option');
    expect(
      options
        .slice(0, 2)
        .every((option) => option.getAttribute('data-local') === 'true'),
    ).toBe(true);
    expect(options[0].textContent).toContain('Local');
    expect(
      document
        .querySelector('[data-value="gpu/qwen-27b"]')
        ?.hasAttribute('data-local'),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Local (2)' }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-value="mac-mlx/spark-x2.5-4b"]',
      ) as HTMLElement,
    );
    expect(onSwitch).toHaveBeenCalledWith('mac-mlx/spark-x2.5-4b');
  });
  it('keeps the Local badge visible on the selected model', () => {
    render(
      createElement(ModelSwitchSelect, {
        models: entries,
        selectedModelId: 'mac-mlx/spark-x2.5-4b',
        onSwitch: vi.fn(),
      }),
    );
    expect(
      screen.getByRole('combobox', { name: 'Switch model' }).textContent,
    ).toContain('Local');
  });
  it('does not label a self-hosted GPU or automatic routing as a local selection', () => {
    const { rerender } = render(
      createElement(ModelSwitchSelect, {
        models: entries,
        selectedModelId: 'gpu/qwen-27b',
        onSwitch: vi.fn(),
      }),
    );
    expect(
      screen.getByRole('combobox', { name: 'Switch model' }).textContent,
    ).not.toContain('Local');
    rerender(
      createElement(ModelSwitchSelect, {
        models: entries,
        selectedModelId: 'gpt-5',
        routing: {
          active: true,
          startTier: 'economy',
          startModel: 'mac-mlx/spark-x2.5-4b',
        },
        onSwitch: vi.fn(),
      }),
    );
    expect(
      screen.getByRole('combobox', {
        name: 'Switch model, automatic routing active',
      }).textContent,
    ).not.toContain('Local');
  });
});
