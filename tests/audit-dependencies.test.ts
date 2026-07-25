import { describe, expect, test } from 'vitest';

import { evaluateAudit } from '../scripts/audit-dependencies.mjs';

const advisory = {
  source: 1,
  name: 'brace-expansion',
  dependency: 'brace-expansion',
  title: 'unbounded expansion',
  url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
  severity: 'high',
  range: '<=5.0.7',
};
const allowlist = {
  'GHSA-mh99-v99m-4gvg': {
    expires: '2026-08-08',
    reason: 'Waiting for a compatible stable development dependency.',
  },
};

describe('dependency audit allowlist', () => {
  test('accepts wrappers caused only by a reviewed advisory', () => {
    const audit = {
      vulnerabilities: {
        'brace-expansion': {
          severity: 'high',
          via: [advisory],
        },
        minimatch: {
          severity: 'high',
          via: ['brace-expansion'],
        },
        'app-builder-lib': {
          severity: 'high',
          via: ['minimatch', 'dmg-builder'],
        },
        'dmg-builder': {
          severity: 'high',
          via: ['app-builder-lib'],
        },
      },
    };

    expect(
      evaluateAudit(audit, allowlist, new Date('2026-07-25T00:00:00Z')),
    ).toEqual({
      allowed: [
        'app-builder-lib',
        'brace-expansion',
        'dmg-builder',
        'minimatch',
      ],
      unallowed: [],
      errors: [],
    });
  });

  test('rejects unrelated advisories', () => {
    const audit = {
      vulnerabilities: {
        'brace-expansion': {
          severity: 'high',
          via: [advisory],
        },
        example: {
          severity: 'moderate',
          via: [
            {
              ...advisory,
              name: 'example',
              url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
            },
          ],
        },
      },
    };

    const result = evaluateAudit(
      audit,
      allowlist,
      new Date('2026-07-25T00:00:00Z'),
    );
    expect(result.allowed).toEqual(['brace-expansion']);
    expect(result.unallowed).toEqual(['example']);
    expect(result.errors).toEqual([]);
  });

  test('rejects expired and stale exceptions', () => {
    const audit = { vulnerabilities: {} };
    const result = evaluateAudit(
      audit,
      allowlist,
      new Date('2026-08-09T00:00:00Z'),
    );

    expect(result.allowed).toEqual([]);
    expect(result.unallowed).toEqual([]);
    expect(result.errors).toEqual([
      'GHSA-mh99-v99m-4gvg expired on 2026-08-08',
      'GHSA-mh99-v99m-4gvg is stale because the advisory is not present',
    ]);
  });
});
