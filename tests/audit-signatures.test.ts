import { describe, expect, test } from 'vitest';

import {
  hasSignatureValidationFailure,
  isMissingAttestationFailure,
  isTransientFailure,
  shouldAllowMissingAttestationFailure,
} from '../scripts/audit-signatures.mjs';

describe('npm signature audit wrapper', () => {
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
});
