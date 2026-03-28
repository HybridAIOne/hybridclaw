import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_HF_TOKEN = process.env.HF_TOKEN;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_GROQ_API_KEY = process.env.GROQ_API_KEY;
const ORIGINAL_DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ORIGINAL_DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ORIGINAL_EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(TEST_DIR, '..');

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function importFreshRuntimeSecrets(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  return import('../src/security/runtime-secrets.ts');
}

async function importFreshRuntimeConfig(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  return import('../src/config/runtime-config.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.chdir(ORIGINAL_CWD);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDAI_API_KEY', ORIGINAL_HYBRIDAI_API_KEY);
  restoreEnvVar('OPENROUTER_API_KEY', ORIGINAL_OPENROUTER_API_KEY);
  restoreEnvVar('HF_TOKEN', ORIGINAL_HF_TOKEN);
  restoreEnvVar('OPENAI_API_KEY', ORIGINAL_OPENAI_API_KEY);
  restoreEnvVar('GROQ_API_KEY', ORIGINAL_GROQ_API_KEY);
  restoreEnvVar('DEEPGRAM_API_KEY', ORIGINAL_DEEPGRAM_API_KEY);
  restoreEnvVar('GEMINI_API_KEY', ORIGINAL_GEMINI_API_KEY);
  restoreEnvVar('GOOGLE_API_KEY', ORIGINAL_GOOGLE_API_KEY);
  restoreEnvVar('DISCORD_TOKEN', ORIGINAL_DISCORD_TOKEN);
  restoreEnvVar('EMAIL_PASSWORD', ORIGINAL_EMAIL_PASSWORD);
});

describe('runtime secrets', () => {
  it('loads credentials from ~/.hybridclaw/credentials.json', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    const credentialsPath = path.join(
      homeDir,
      '.hybridclaw',
      'credentials.json',
    );
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(
      credentialsPath,
      `${JSON.stringify(
        {
          HYBRIDAI_API_KEY: 'hai-1234567890abcdef',
          OPENROUTER_API_KEY: 'or-1234567890abcdef',
          HF_TOKEN: 'hf_1234567890abcdef',
          OPENAI_API_KEY: 'sk-test-openai-key',
          GROQ_API_KEY: 'gsk_test_groq',
          DEEPGRAM_API_KEY: 'deepgram-test-key',
          GEMINI_API_KEY: 'gemini-test-key',
          GOOGLE_API_KEY: 'google-test-key',
          DISCORD_TOKEN: 'discord-token',
          EMAIL_PASSWORD: 'email-password',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    delete process.env.HYBRIDAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.DISCORD_TOKEN;
    delete process.env.EMAIL_PASSWORD;

    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.loadRuntimeSecrets();

    expect(runtimeSecrets.runtimeSecretsPath()).toBe(credentialsPath);
    expect(process.env.HYBRIDAI_API_KEY).toBe('hai-1234567890abcdef');
    expect(process.env.OPENROUTER_API_KEY).toBe('or-1234567890abcdef');
    expect(process.env.HF_TOKEN).toBe('hf_1234567890abcdef');
    expect(process.env.OPENAI_API_KEY).toBe('sk-test-openai-key');
    expect(process.env.GROQ_API_KEY).toBe('gsk_test_groq');
    expect(process.env.DEEPGRAM_API_KEY).toBe('deepgram-test-key');
    expect(process.env.GEMINI_API_KEY).toBe('gemini-test-key');
    expect(process.env.GOOGLE_API_KEY).toBe('google-test-key');
    expect(process.env.DISCORD_TOKEN).toBe('discord-token');
    expect(process.env.EMAIL_PASSWORD).toBe('email-password');
  });

  it('saves credentials under ~/.hybridclaw/credentials.json', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    const credentialsPath = path.join(
      homeDir,
      '.hybridclaw',
      'credentials.json',
    );
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);

    const writtenPath = runtimeSecrets.saveRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-fedcba0987654321',
      OPENROUTER_API_KEY: 'or-fedcba0987654321',
      HF_TOKEN: 'hf_fedcba0987654321',
      OPENAI_API_KEY: 'sk-saved-openai-key',
      GROQ_API_KEY: 'gsk_saved_groq',
      DEEPGRAM_API_KEY: 'deepgram-saved-key',
      GEMINI_API_KEY: 'gemini-saved-key',
      GOOGLE_API_KEY: 'google-saved-key',
      DISCORD_TOKEN: 'discord-token',
      EMAIL_PASSWORD: 'email-password',
    });

    expect(writtenPath).toBe(credentialsPath);
    expect(
      JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as Record<
        string,
        string
      >,
    ).toEqual({
      HYBRIDAI_API_KEY: 'hai-fedcba0987654321',
      OPENROUTER_API_KEY: 'or-fedcba0987654321',
      HF_TOKEN: 'hf_fedcba0987654321',
      OPENAI_API_KEY: 'sk-saved-openai-key',
      GROQ_API_KEY: 'gsk_saved_groq',
      DEEPGRAM_API_KEY: 'deepgram-saved-key',
      GEMINI_API_KEY: 'gemini-saved-key',
      GOOGLE_API_KEY: 'google-saved-key',
      DISCORD_TOKEN: 'discord-token',
      EMAIL_PASSWORD: 'email-password',
    });
  });

  it('migrates supported secrets from .env into ~/.hybridclaw/credentials.json', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    const cwdDir = makeTempDir('hybridclaw-runtime-cwd-');
    const envPath = path.join(cwdDir, '.env');
    const credentialsPath = path.join(
      homeDir,
      '.hybridclaw',
      'credentials.json',
    );
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    fs.writeFileSync(
      envPath,
      [
        'HYBRIDAI_API_KEY=hai-from-dot-env',
        'OPENROUTER_API_KEY=or-from-dot-env',
        'HF_TOKEN=hf-from-dot-env',
        'OPENAI_API_KEY=sk-from-dot-env',
        'GROQ_API_KEY=gsk-from-dot-env',
        'DEEPGRAM_API_KEY=deepgram-from-dot-env',
        'GEMINI_API_KEY=gemini-from-dot-env',
        'GOOGLE_API_KEY=google-from-dot-env',
        'DISCORD_TOKEN=discord-from-dot-env',
        'EMAIL_PASSWORD=email-password-from-dot-env',
        'UNRELATED=value',
        '',
      ].join('\n'),
      'utf-8',
    );
    delete process.env.HYBRIDAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.DISCORD_TOKEN;
    delete process.env.EMAIL_PASSWORD;
    process.chdir(cwdDir);

    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.loadRuntimeSecrets();

    expect(infoSpy).toHaveBeenCalledWith(
      `Migrating .env to ${credentialsPath}`,
    );
    expect(
      JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as Record<
        string,
        string
      >,
    ).toEqual({
      HYBRIDAI_API_KEY: 'hai-from-dot-env',
      OPENROUTER_API_KEY: 'or-from-dot-env',
      HF_TOKEN: 'hf-from-dot-env',
      OPENAI_API_KEY: 'sk-from-dot-env',
      GROQ_API_KEY: 'gsk-from-dot-env',
      DEEPGRAM_API_KEY: 'deepgram-from-dot-env',
      GEMINI_API_KEY: 'gemini-from-dot-env',
      GOOGLE_API_KEY: 'google-from-dot-env',
      DISCORD_TOKEN: 'discord-from-dot-env',
      EMAIL_PASSWORD: 'email-password-from-dot-env',
    });
    expect(process.env.HYBRIDAI_API_KEY).toBe('hai-from-dot-env');
    expect(process.env.OPENROUTER_API_KEY).toBe('or-from-dot-env');
    expect(process.env.HF_TOKEN).toBe('hf-from-dot-env');
    expect(process.env.OPENAI_API_KEY).toBe('sk-from-dot-env');
    expect(process.env.GROQ_API_KEY).toBe('gsk-from-dot-env');
    expect(process.env.DEEPGRAM_API_KEY).toBe('deepgram-from-dot-env');
    expect(process.env.GEMINI_API_KEY).toBe('gemini-from-dot-env');
    expect(process.env.GOOGLE_API_KEY).toBe('google-from-dot-env');
    expect(process.env.DISCORD_TOKEN).toBe('discord-from-dot-env');
    expect(process.env.EMAIL_PASSWORD).toBe('email-password-from-dot-env');
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(
      'HYBRIDAI_API_KEY=hai-from-dot-env',
    );
  });

  it('refreshes managed secrets when credentials.json changes', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    delete process.env.HF_TOKEN;

    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({ HF_TOKEN: 'hf-old-token' });
    runtimeSecrets.loadRuntimeSecrets();
    expect(process.env.HF_TOKEN).toBe('hf-old-token');

    runtimeSecrets.saveRuntimeSecrets({ HF_TOKEN: 'hf-new-token' });
    runtimeSecrets.loadRuntimeSecrets();
    expect(process.env.HF_TOKEN).toBe('hf-new-token');

    runtimeSecrets.saveRuntimeSecrets({ HF_TOKEN: null });
    runtimeSecrets.loadRuntimeSecrets();
    expect(process.env.HF_TOKEN).toBeUndefined();
  });

  it('does not override shell-provided secrets during refresh', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    process.env.HF_TOKEN = 'hf-from-shell';

    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({ HF_TOKEN: 'hf-from-file' });
    runtimeSecrets.loadRuntimeSecrets();

    expect(process.env.HF_TOKEN).toBe('hf-from-shell');
  });
});

describe('runtime home layout', () => {
  it('does not probe or migrate runtime files in the current working directory', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-home-');
    const cwdDir = makeTempDir('hybridclaw-runtime-cwd-');
    const legacyConfigPath = path.join(cwdDir, 'config.json');
    const legacyDataDir = path.join(cwdDir, 'data');
    const legacyMarkerPath = path.join(legacyDataDir, 'marker.txt');
    const legacyConfig = JSON.parse(
      fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'config.example.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    legacyConfig.hybridai.defaultChatbotId = 'legacy-bot-id';

    fs.writeFileSync(
      legacyConfigPath,
      `${JSON.stringify(legacyConfig, null, 2)}\n`,
      'utf-8',
    );
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.writeFileSync(legacyMarkerPath, 'legacy-data\n', 'utf-8');

    process.chdir(cwdDir);
    await importFreshRuntimeConfig(homeDir);

    const homeConfigPath = path.join(homeDir, '.hybridclaw', 'config.json');
    const homeConfig = JSON.parse(
      fs.readFileSync(homeConfigPath, 'utf-8'),
    ) as RuntimeConfig;

    expect(homeConfig.hybridai.defaultChatbotId).toBe('');
    expect(fs.existsSync(legacyConfigPath)).toBe(true);
    expect(fs.readFileSync(legacyMarkerPath, 'utf-8')).toBe('legacy-data\n');
    expect(
      fs.existsSync(path.join(homeDir, '.hybridclaw', 'migration-backups')),
    ).toBe(false);
  });

  it('does not treat ~/.hybridclaw/data as a legacy cwd data directory when launched from runtime home', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-home-');
    const runtimeHomeDir = path.join(homeDir, '.hybridclaw');
    const runtimeDataDir = path.join(runtimeHomeDir, 'data');
    const runtimeMarkerPath = path.join(runtimeDataDir, 'marker.txt');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fs.mkdirSync(runtimeDataDir, { recursive: true });
    fs.writeFileSync(runtimeMarkerPath, 'runtime-data\n', 'utf-8');

    process.chdir(runtimeHomeDir);
    await importFreshRuntimeConfig(homeDir);

    expect(fs.readFileSync(runtimeMarkerPath, 'utf-8')).toBe('runtime-data\n');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('runtime data migration failed'),
    );
    expect(fs.existsSync(path.join(runtimeHomeDir, 'migration-backups'))).toBe(
      false,
    );
  });
});
