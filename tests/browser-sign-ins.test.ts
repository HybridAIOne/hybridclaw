import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-browser-sign-ins-');

describe('website sign-ins', () => {
  useCleanMocks({ resetModules: true, unstubAllEnvs: true });

  async function importSignIns() {
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', makeTempDir());
    vi.stubEnv('HYBRIDCLAW_MASTER_KEY', 'a'.repeat(64));
    const runtimeSecrets = await import('../src/security/runtime-secrets.js');
    const signIns = await import('../src/security/browser-sign-ins.js');
    return { runtimeSecrets, signIns };
  }

  test('keeps a sign-in in the encrypted store, bound to its exact host', async () => {
    const { runtimeSecrets, signIns } = await importSignIns();

    expect(
      signIns.saveBrowserSignIn({
        host: 'HybridAI.one.',
        username: ' ben@example.com ',
        password: 'pw-secret',
      }),
    ).toEqual({
      host: 'hybridai.one',
      usernameSecret: 'SIGNIN_HYBRIDAI_ONE_USERNAME',
      passwordSecret: 'SIGNIN_HYBRIDAI_ONE_PASSWORD',
    });
    expect(
      runtimeSecrets.readStoredRuntimeSecret('SIGNIN_HYBRIDAI_ONE_USERNAME'),
    ).toBe('ben@example.com');
    expect(
      runtimeSecrets.readStoredRuntimeSecret(
        'SIGNIN_HYBRIDAI_ONE_PASSWORD_BOUND_DOMAIN',
      ),
    ).toBe('hybridai.one');
    expect(signIns.findBrowserSignIn('hybridai.one')?.passwordSecret).toBe(
      'SIGNIN_HYBRIDAI_ONE_PASSWORD',
    );
    // Neither a subdomain nor a parent shares it.
    expect(signIns.findBrowserSignIn('app.hybridai.one')).toBeNull();
    expect(signIns.listBrowserSignIns()).toEqual([
      { host: 'hybridai.one', username: true, savedAt: expect.any(String) },
    ]);

    expect(signIns.deleteBrowserSignIn('hybridai.one')).toBe(true);
    expect(signIns.deleteBrowserSignIn('hybridai.one')).toBe(false);
    expect(runtimeSecrets.listStoredRuntimeSecretNames()).toEqual([]);
  });

  test('lets a sign-in reach only its own host', async () => {
    const { runtimeSecrets, signIns } = await importSignIns();
    signIns.saveBrowserSignIn({ host: 'hybridai.one', password: 'pw-secret' });

    expect(
      signIns.browserSignInHostProblem(
        'SIGNIN_HYBRIDAI_ONE_PASSWORD',
        'HybridAI.one',
      ),
    ).toBe('');
    for (const host of [
      'app.hybridai.one',
      'hybridai.one.evil.example',
      'evil.example',
      '',
      undefined,
    ]) {
      expect(
        signIns.browserSignInHostProblem('SIGNIN_HYBRIDAI_ONE_PASSWORD', host),
      ).toMatch(/only for hybridai\.one/);
    }

    // Written past the app, without a binding, it never resolves.
    runtimeSecrets.saveNamedRuntimeSecrets({ SIGNIN_BANK_PASSWORD: 'x' });
    expect(
      signIns.browserSignInHostProblem('SIGNIN_BANK_PASSWORD', 'bank'),
    ).toMatch(/not bound to a site/);
    // Other secrets are the workspace policy's business.
    expect(signIns.browserSignInHostProblem('DATEV_PASSWORD', 'evil')).toBe('');
  });

  test('a later host with the same slug replaces the earlier sign-in', async () => {
    const { signIns } = await importSignIns();
    signIns.saveBrowserSignIn({ host: 'a-b.example', password: 'first' });
    signIns.saveBrowserSignIn({ host: 'a.b.example', password: 'second' });

    expect(signIns.findBrowserSignIn('a-b.example')).toBeNull();
    expect(signIns.findBrowserSignIn('a.b.example')).not.toBeNull();
    expect(
      signIns.browserSignInHostProblem(
        'SIGNIN_A_B_EXAMPLE_PASSWORD',
        'a-b.example',
      ),
    ).toMatch(/only for a\.b\.example/);
  });

  test('a password-only sign-in drops an earlier username', async () => {
    const { signIns } = await importSignIns();
    signIns.saveBrowserSignIn({
      host: 'pin.example',
      username: 'old',
      password: 'one',
    });
    signIns.saveBrowserSignIn({ host: 'pin.example', password: 'two' });

    expect(signIns.findBrowserSignIn('pin.example')).toEqual({
      host: 'pin.example',
      passwordSecret: 'SIGNIN_PIN_EXAMPLE_PASSWORD',
    });
  });

  test('refuses what it cannot save faithfully', async () => {
    const { signIns } = await importSignIns();

    expect(() =>
      signIns.saveBrowserSignIn({ host: 'https://x.example/', password: 'p' }),
    ).toThrow('Expected the site as a hostname.');
    expect(() =>
      signIns.saveBrowserSignIn({ host: 'x.example', password: '  ' }),
    ).toThrow('Expected a password.');
    expect(() =>
      signIns.saveBrowserSignIn({ host: 'x.example', password: ' padded' }),
    ).toThrow(/starts or ends with a space/);
  });

  test('long hosts still make valid store names', async () => {
    const { runtimeSecrets, signIns } = await importSignIns();
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.example`;
    const names = signIns.browserSignInSecretNames(host);

    expect(runtimeSecrets.isRuntimeSecretName(names.password)).toBe(true);
    expect(
      runtimeSecrets.isRuntimeSecretName(`${names.password}_BOUND_DOMAIN`),
    ).toBe(true);
    signIns.saveBrowserSignIn({ host, username: 'u', password: 'p' });
    expect(signIns.findBrowserSignIn(host)?.usernameSecret).toBe(
      names.username,
    );
  });
});
