import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  hasSignatureValidationFailure,
  isMissingAttestationFailure,
  isTransientFailure,
  runAudit,
  signatureAuditTargets,
  shouldAllowMissingAttestationFailure,
} from '../scripts/audit-signatures.mjs';
import { useCleanMocks } from './test-utils.js';

const { spawnSync } = vi.hoisted(() => {
  vi.stubEnv('HYBRIDCLAW_NPM_AUDIT_SIGNATURE_RETRY_DELAY_MS', '0');
  return { spawnSync: vi.fn() };
});

vi.mock('node:child_process', () => ({ spawnSync }));

const missingKeyFailure = {
  status: 1,
  stdout: '',
  stderr: `npm error code EMISSINGSIGNATUREKEY
npm error pkg-a@1.0.0 has attestations but no corresponding public key(s) can be found`,
};
const integrityFailure = {
  status: 1,
  stdout: '',
  stderr: 'npm error code EINTEGRITY',
};
const invalidSignatureFailure = {
  status: 1,
  stdout: `1 package has an invalid registry signature:

pkg-a@1.0.0 (https://registry.npmjs.org/)`,
  stderr: '',
};
const success = { status: 0, stdout: '', stderr: '' };

describe('npm signature audit wrapper', () => {
  test('does not apply the install release-age gate during verification', () => {
    for (const target of signatureAuditTargets) {
      expect(target.args).toContain('--min-release-age=0');
    }
  });

  test('treats npm registry attestation 404s as best-effort', () => {
    const output = `npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/-/npm/v1/attestations/@slack%2fweb-api@7.15.0 - Not found`;

    expect(isMissingAttestationFailure(output)).toBe(true);
    expect(isTransientFailure(output)).toBe(true);
    expect(shouldAllowMissingAttestationFailure(output)).toBe(true);
  });

  test('keeps registry signature validation failures fatal', () => {
    const output = `npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/-/npm/v1/attestations/discord.js@14.25.1 - Not found
1 package has missing registry signatures but the registry is providing signing keys:`;

    expect(hasSignatureValidationFailure(output)).toBe(true);
    expect(shouldAllowMissingAttestationFailure(output)).toBe(false);
  });

  describe('runAudit retries', () => {
    useCleanMocks({ restoreAllMocks: true, unstubAllEnvs: true });

    beforeEach(() => {
      spawnSync.mockReset();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    test.each([
      ['a missing attestation key that clears', [missingKeyFailure, success], 0],
      [
        'a missing attestation key that persists',
        [missingKeyFailure, missingKeyFailure, missingKeyFailure],
        1,
      ],
      ['an integrity failure', [integrityFailure], 1],
      ['an invalid registry signature', [invalidSignatureFailure], 1],
    ])('handles %s', (_name, results, expectedStatus) => {
      for (const result of results) {
        spawnSync.mockReturnValueOnce(result);
      }

      expect(runAudit(signatureAuditTargets[0])).toBe(expectedStatus);
      expect(spawnSync).toHaveBeenCalledTimes(results.length);
    });

    test('retries with a fresh npm cache so cached attestations are refetched', () => {
      spawnSync
        .mockReturnValueOnce(missingKeyFailure)
        .mockReturnValueOnce(missingKeyFailure)
        .mockReturnValueOnce(success);

      expect(runAudit(signatureAuditTargets[0])).toBe(0);
      const caches = spawnSync.mock.calls.map(
        ([, , options]) => options.env.NPM_CONFIG_CACHE,
      );
      expect(new Set(caches).size).toBe(3);
    });
  });
});
