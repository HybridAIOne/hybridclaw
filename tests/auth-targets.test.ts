import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AUTH_TARGETS, resolveAuthTarget } from '../src/auth/auth-targets.js';
import { handleAuthCommand } from '../src/cli/auth-command.js';
import { printHelpTopic } from '../src/cli/help.js';
import { PROVIDER_ALIASES } from '../src/providers/provider-aliases.js';
import { useCleanMocks } from './test-utils.ts';

useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unmock: ['../src/providers/provider-aliases.ts'],
});

function captureLogs(): string[][] {
  return vi.spyOn(console, 'log').mockImplementation(() => {}).mock
    .calls as string[][];
}

describe('resolveAuthTarget', () => {
  it.each(AUTH_TARGETS)('resolves the canonical name %s to itself', (name) => {
    expect(resolveAuthTarget(name)).toBe(name);
  });

  it.each(
    Object.entries(PROVIDER_ALIASES),
  )('resolves model-provider alias %s like %s', (alias, provider) => {
    expect(resolveAuthTarget(alias)).not.toBeNull();
    expect(resolveAuthTarget(alias)).toBe(resolveAuthTarget(provider));
  });

  it.each([
    ['hybrid', 'hybridai'],
    ['hybrid-ai', 'hybridai'],
    ['openai-codex', 'codex'],
    ['claude', 'anthropic'],
    ['or', 'openrouter'],
    ['hf', 'huggingface'],
    ['hugging-face', 'huggingface'],
    ['huggingface-hub', 'huggingface'],
    ['google', 'google'],
    ['gog', 'google'],
    ['hs', 'hubspot'],
    ['microsoft-365', 'microsoft365'],
    ['m365', 'microsoft365'],
    ['office365', 'microsoft365'],
    ['office-365', 'microsoft365'],
    ['graph', 'microsoft365'],
    ['msgraph', 'microsoft365'],
    ['google-gemini', 'gemini'],
    ['grok', 'xai'],
    ['teams', 'msteams'],
    ['ms-teams', 'msteams'],
    [' M365 ', 'microsoft365'],
  ])('resolves %j to %s', (name, target) => {
    expect(resolveAuthTarget(name)).toBe(target);
  });

  it.each([
    '',
    undefined,
    'nonsense',
    'gemini/gemini-2.5-pro',
  ])('returns null for %j', (name) => {
    expect(resolveAuthTarget(name)).toBeNull();
  });

  it('fails at load when two targets claim one name', async () => {
    vi.resetModules();
    vi.doMock('../src/providers/provider-aliases.ts', async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('../src/providers/provider-aliases.js')
        >();
      return {
        ...actual,
        getProviderAliasesFor: (id: 'gemini') =>
          id === 'gemini'
            ? ['google', ...actual.getProviderAliasesFor(id)]
            : actual.getProviderAliasesFor(id),
      };
    });

    await expect(import('../src/auth/auth-targets.ts')).rejects.toThrow(
      '"google" is claimed by both',
    );
  });
});

describe('hybridclaw auth logout <name>', () => {
  it.each([
    ['google', 'Cleared Google OAuth credentials'],
    ['gog', 'Cleared Google OAuth credentials'],
    ['hs', 'Cleared HubSpot credentials'],
    ['msgraph', 'Cleared Microsoft 365 OAuth credentials'],
    ['ms-teams', 'Cleared Microsoft Teams credentials'],
    ['hugging-face', 'Cleared Hugging Face credentials'],
    ['or', 'Cleared OpenRouter credentials'],
    ['google-gemini', 'Cleared Google Gemini credentials'],
    ['grok', 'Cleared xAI credentials'],
  ])('%s → %s', async (name, message) => {
    const logs = captureLogs();

    await handleAuthCommand(['logout', name]);

    expect(logs.flat().join('\n')).toContain(message);
  });

  it('names every target when the name is unknown', async () => {
    const error = await handleAuthCommand(['logout', 'nonsense']).catch(
      (err: Error) => err,
    );

    expect(error).toBeInstanceOf(Error);
    for (const target of AUTH_TARGETS) {
      expect((error as Error).message).toContain(`\`${target}\``);
    }
  });
});

describe('hybridclaw help <name>', () => {
  it.each([
    ['teams', 'msteams'],
    ['claude', 'anthropic'],
    ['hf', 'huggingface'],
    ['hs', 'hubspot'],
    ['m365', 'microsoft365'],
    ['msgraph', 'microsoft365'],
    ['or', 'openrouter'],
    ['hybrid', 'hybridai'],
    ['openai-codex', 'codex'],
  ])('%s prints the %s usage', async (name, canonical) => {
    const logs = captureLogs();
    await printHelpTopic(canonical);
    const expected = logs.splice(0);
    expect(expected).not.toEqual([]);

    await expect(printHelpTopic(name)).resolves.toBe(true);
    expect(logs).toEqual(expected);
  });
});

describe('gateway auth status <name>', () => {
  let handleGatewayCommand: typeof import('../src/gateway/gateway-service.js').handleGatewayCommand;

  beforeAll(async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    ({ handleGatewayCommand } = await import(
      '../src/gateway/gateway-service.ts'
    ));
    initDatabase({ quiet: true });
  });

  function authStatus(name: string) {
    return handleGatewayCommand({
      sessionId: `session-auth-targets-${name}`,
      guildId: null,
      channelId: 'tui',
      args: ['auth', 'status', name],
    });
  }

  it.each([
    ['hybrid', 'HybridAI Auth Status'],
    ['openai-codex', 'Codex Auth Status'],
    ['or', 'OpenRouter Auth Status'],
    ['hf', 'Hugging Face Auth Status'],
    ['ms-teams', 'Microsoft Teams Auth Status'],
  ])('%s → %s', async (name, title) => {
    const result = await authStatus(name);

    expect(result).toMatchObject({ kind: 'info', title });
  });

  it.each([
    'gemini',
    'nonsense',
  ])('answers %s with the usage line', async (name) => {
    const result = await authStatus(name);

    expect(result).toMatchObject({ kind: 'error', title: 'Usage' });
    expect(result.text).toContain('auth status <hybridai|codex|');
  });
});
