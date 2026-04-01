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
const ORIGINAL_HYBRIDCLAW_MASTER_KEY = process.env.HYBRIDCLAW_MASTER_KEY;
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

async function importFreshRuntimeSecretsBootstrap(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  return import('../src/security/runtime-secrets-bootstrap.ts');
}

async function importFreshRuntimeConfig(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  return import('../src/config/runtime-config.ts');
}

async function importFreshConfigGlobals(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  return import('../src/config/config.ts');
}

function readSecretStoreFile(homeDir: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.join(homeDir, '.hybridclaw', 'credentials.json'),
      'utf-8',
    ),
  ) as Record<string, unknown>;
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
  restoreEnvVar('HYBRIDCLAW_MASTER_KEY', ORIGINAL_HYBRIDCLAW_MASTER_KEY);
});

describe('runtime secrets', () => {
  it('bootstraps and migrates plaintext credentials from ~/.hybridclaw/credentials.json', async () => {
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
    const runtimeSecretsBootstrap =
      await importFreshRuntimeSecretsBootstrap(homeDir);
    runtimeSecretsBootstrap.bootstrapRuntimeSecrets();

    expect(runtimeSecrets.runtimeSecretsPath()).toBe(credentialsPath);
    expect(runtimeSecrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
      'hai-1234567890abcdef',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('OPENROUTER_API_KEY')).toBe(
      'or-1234567890abcdef',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('HF_TOKEN')).toBe(
      'hf_1234567890abcdef',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('OPENAI_API_KEY')).toBe(
      'sk-test-openai-key',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GROQ_API_KEY')).toBe(
      'gsk_test_groq',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('DEEPGRAM_API_KEY')).toBe(
      'deepgram-test-key',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GEMINI_API_KEY')).toBe(
      'gemini-test-key',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GOOGLE_API_KEY')).toBe(
      'google-test-key',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('DISCORD_TOKEN')).toBe(
      'discord-token',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('EMAIL_PASSWORD')).toBe(
      'email-password',
    );
    const stored = readSecretStoreFile(homeDir);
    expect(stored.version).toBe(1);
    expect(JSON.stringify(stored)).not.toContain('hai-1234567890abcdef');
    expect(
      fs.existsSync(
        path.join(homeDir, '.hybridclaw', 'credentials.json.legacy'),
      ),
    ).toBe(false);
    expect(process.env.HYBRIDAI_API_KEY).toBeUndefined();
  });

  it('drops reserved non-secret config keys during plaintext credential migration', async () => {
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
          CONTAINER_IMAGE: 'hybridclaw-agent',
          CONTAINER_MEMORY: '2g',
          CONTAINER_CPUS: '4',
          CONTAINER_TIMEOUT: '300000',
          DISCORD_PREFIX: '!claw',
          HEALTH_PORT: '8080',
          LOG_LEVEL: 'debug',
          DB_PATH: '/tmp/hybridclaw.db',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    const runtimeSecretsBootstrap =
      await importFreshRuntimeSecretsBootstrap(homeDir);
    runtimeSecretsBootstrap.bootstrapRuntimeSecrets();

    expect(runtimeSecrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
      'hai-1234567890abcdef',
    );
    expect(
      runtimeSecrets.readStoredRuntimeSecret('CONTAINER_IMAGE'),
    ).toBeNull();
    expect(
      runtimeSecrets.readStoredRuntimeSecret('CONTAINER_MEMORY'),
    ).toBeNull();
    expect(runtimeSecrets.readStoredRuntimeSecret('CONTAINER_CPUS')).toBeNull();
    expect(
      runtimeSecrets.readStoredRuntimeSecret('CONTAINER_TIMEOUT'),
    ).toBeNull();
    expect(runtimeSecrets.readStoredRuntimeSecret('DISCORD_PREFIX')).toBeNull();
    expect(runtimeSecrets.readStoredRuntimeSecret('HEALTH_PORT')).toBeNull();
    expect(runtimeSecrets.readStoredRuntimeSecret('LOG_LEVEL')).toBeNull();
    expect(runtimeSecrets.readStoredRuntimeSecret('DB_PATH')).toBeNull();

    const stored = readSecretStoreFile(homeDir);
    expect(JSON.stringify(stored)).not.toContain('CONTAINER_IMAGE');
    expect(JSON.stringify(stored)).not.toContain('CONTAINER_MEMORY');
    expect(JSON.stringify(stored)).not.toContain('CONTAINER_CPUS');
    expect(JSON.stringify(stored)).not.toContain('CONTAINER_TIMEOUT');
    expect(JSON.stringify(stored)).not.toContain('DISCORD_PREFIX');
    expect(JSON.stringify(stored)).not.toContain('HEALTH_PORT');
    expect(JSON.stringify(stored)).not.toContain('LOG_LEVEL');
    expect(JSON.stringify(stored)).not.toContain('DB_PATH');
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
    const stored = readSecretStoreFile(homeDir);
    expect(stored.version).toBe(1);
    expect(JSON.stringify(stored)).not.toContain('hai-fedcba0987654321');
    expect(fs.statSync(path.join(homeDir, '.hybridclaw')).mode & 0o777).toBe(
      0o700,
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
      'hai-fedcba0987654321',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('OPENROUTER_API_KEY')).toBe(
      'or-fedcba0987654321',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('HF_TOKEN')).toBe(
      'hf_fedcba0987654321',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('OPENAI_API_KEY')).toBe(
      'sk-saved-openai-key',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GROQ_API_KEY')).toBe(
      'gsk_saved_groq',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('DEEPGRAM_API_KEY')).toBe(
      'deepgram-saved-key',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GEMINI_API_KEY')).toBe(
      'gemini-saved-key',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GOOGLE_API_KEY')).toBe(
      'google-saved-key',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('DISCORD_TOKEN')).toBe(
      'discord-token',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('EMAIL_PASSWORD')).toBe(
      'email-password',
    );
  });

  it('rejects reserved non-secret config names in the named secret store', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);

    expect(() =>
      runtimeSecrets.saveNamedRuntimeSecrets({ CONTAINER_MEMORY: '2g' }),
    ).toThrow(/reserved for non-secret runtime config/);
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
    expect(readSecretStoreFile(homeDir).version).toBe(1);
    expect(runtimeSecrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
      'hai-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('OPENROUTER_API_KEY')).toBe(
      'or-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('HF_TOKEN')).toBe(
      'hf-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('OPENAI_API_KEY')).toBe(
      'sk-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GROQ_API_KEY')).toBe(
      'gsk-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('DEEPGRAM_API_KEY')).toBe(
      'deepgram-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GEMINI_API_KEY')).toBe(
      'gemini-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('GOOGLE_API_KEY')).toBe(
      'google-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('DISCORD_TOKEN')).toBe(
      'discord-from-dot-env',
    );
    expect(runtimeSecrets.readStoredRuntimeSecret('EMAIL_PASSWORD')).toBe(
      'email-password-from-dot-env',
    );
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(
      'HYBRIDAI_API_KEY=hai-from-dot-env',
    );
  });

  it('reads updated managed secrets when credentials.json changes', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');

    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({ HF_TOKEN: 'hf-old-token' });
    expect(runtimeSecrets.readStoredRuntimeSecret('HF_TOKEN')).toBe(
      'hf-old-token',
    );

    runtimeSecrets.saveRuntimeSecrets({ HF_TOKEN: 'hf-new-token' });
    expect(runtimeSecrets.readStoredRuntimeSecret('HF_TOKEN')).toBe(
      'hf-new-token',
    );

    runtimeSecrets.saveRuntimeSecrets({ HF_TOKEN: null });
    expect(runtimeSecrets.readStoredRuntimeSecret('HF_TOKEN')).toBeNull();
  });

  it('fails closed when the master key does not match the encrypted store', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    process.env.HYBRIDCLAW_MASTER_KEY = 'correct-master-key';
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-master-key-mismatch-test',
    });

    process.env.HYBRIDCLAW_MASTER_KEY = 'wrong-master-key';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reloaded = await importFreshRuntimeSecrets(homeDir);

    expect(reloaded.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to decrypt'),
    );
  });

  it('does not migrate .env secrets over an unreadable encrypted store', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    const cwdDir = makeTempDir('hybridclaw-runtime-cwd-');
    const envPath = path.join(cwdDir, '.env');
    process.env.HYBRIDCLAW_MASTER_KEY = 'correct-master-key';
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-preserve-existing-secret',
    });
    const encryptedBefore = fs.readFileSync(
      runtimeSecrets.runtimeSecretsPath(),
      'utf-8',
    );

    fs.writeFileSync(envPath, 'HYBRIDAI_API_KEY=hai-from-dot-env\n', 'utf-8');
    process.chdir(cwdDir);
    process.env.HYBRIDCLAW_MASTER_KEY = 'wrong-master-key';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const reloaded = await importFreshRuntimeSecrets(homeDir);

    reloaded.loadRuntimeSecrets();

    expect(fs.readFileSync(reloaded.runtimeSecretsPath(), 'utf-8')).toBe(
      encryptedBefore,
    );
    expect(reloaded.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to decrypt'),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Migrating .env to'),
    );
  });

  it('restores the legacy plaintext file when encrypted migration validation fails', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    const cwdDir = makeTempDir('hybridclaw-runtime-cwd-');
    const credentialsPath = path.join(
      homeDir,
      '.hybridclaw',
      'credentials.json',
    );
    const legacyPath = `${credentialsPath}.legacy`;
    const plaintextCredentials = `${JSON.stringify(
      { HYBRIDAI_API_KEY: 'hai-validation-rollback-test' },
      null,
      2,
    )}\n`;
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(credentialsPath, plaintextCredentials, 'utf-8');
    process.chdir(cwdDir);

    const originalReadFileSync = fs.readFileSync.bind(fs);
    let credentialsReadCount = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath, options) => {
      if (String(filePath) === credentialsPath && options === 'utf-8') {
        credentialsReadCount += 1;
        if (credentialsReadCount === 2) {
          return '{"version":1,"entries":' as never;
        }
      }
      return originalReadFileSync(filePath as never, options as never) as never;
    }) as typeof fs.readFileSync);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtimeSecretsBootstrap =
      await importFreshRuntimeSecretsBootstrap(homeDir);

    runtimeSecretsBootstrap.bootstrapRuntimeSecrets();

    expect(fs.readFileSync(credentialsPath, 'utf-8')).toBe(
      plaintextCredentials,
    );
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to migrate legacy plaintext credentials'),
    );
  });

  it('treats runtime home permission fixes as best effort', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-best-effort-permissions',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chmodSpy = vi.spyOn(fs, 'chmodSync').mockImplementation((target) => {
      if (target === path.join(homeDir, '.hybridclaw')) {
        throw new Error('read-only filesystem');
      }
    });

    const reloaded = await importFreshRuntimeSecrets(homeDir);

    expect(reloaded.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
      'hai-best-effort-permissions',
    );
    expect(chmodSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to set permissions'),
    );
  });

  it('preserves the previous encrypted store when atomic secret writes fail', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-before-atomic-write-failure',
    });
    const encryptedBefore = fs.readFileSync(
      runtimeSecrets.runtimeSecretsPath(),
      'utf-8',
    );
    const originalRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation(((source, destination) => {
      if (
        String(destination) === runtimeSecrets.runtimeSecretsPath() &&
        String(source).includes('.tmp-')
      ) {
        throw new Error('simulated rename failure');
      }
      return originalRenameSync(source, destination);
    }) as typeof fs.renameSync);

    expect(() =>
      runtimeSecrets.saveRuntimeSecrets({
        HYBRIDAI_API_KEY: 'hai-after-atomic-write-failure',
      }),
    ).toThrow(/simulated rename failure/);
    expect(
      fs.readFileSync(runtimeSecrets.runtimeSecretsPath(), 'utf-8'),
    ).toBe(encryptedBefore);

    const reloaded = await importFreshRuntimeSecrets(homeDir);
    expect(reloaded.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
      'hai-before-atomic-write-failure',
    );
  });

  it('does not override shell-provided secrets during config refresh', async () => {
    const homeDir = makeTempDir('hybridclaw-runtime-secrets-');
    process.env.HF_TOKEN = 'hf-from-shell';

    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({ HF_TOKEN: 'hf-from-file' });
    const config = await importFreshConfigGlobals(homeDir);
    config.refreshRuntimeSecretsFromEnv();

    expect(config.HUGGINGFACE_API_KEY).toBe('hf-from-shell');
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
