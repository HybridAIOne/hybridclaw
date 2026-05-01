import { describe, expect, test } from 'vitest';

import {
  compareUserIds,
  formatUserId,
  isReservedUserAuthority,
  parseUserId,
  USER_ID_DEFAULT_AUTHORITY,
  USER_ID_LOCAL_AUTHORITY,
  UserIdValidationError,
  userIdsEqual,
} from '../src/identity/user-id.js';

describe('canonical user ids', () => {
  test('parses and normalizes username@authority ids', () => {
    expect(parseUserId(' Lena.Smith@HybridAI ')).toEqual({
      id: 'lena.smith@hybridai',
      username: 'lena.smith',
      authority: 'hybridai',
    });
  });

  test('formats ids with the canonical HybridAI authority by default', () => {
    expect(formatUserId('Lena.Smith')).toBe('lena.smith@hybridai');
    expect(USER_ID_DEFAULT_AUTHORITY).toBe('hybridai');
  });

  test('formats local single-instance ids explicitly', () => {
    expect(formatUserId('operator_1', USER_ID_LOCAL_AUTHORITY)).toBe(
      'operator_1@local',
    );
  });

  test('round-trips valid ids through parse and format', () => {
    const values = [
      'lena@hybridai',
      'operator_1@local',
      'sam.dev@example-authority',
      'team-lead@company.example',
    ];

    for (const value of values) {
      const parsed = parseUserId(value);
      expect(formatUserId(parsed.username, parsed.authority)).toBe(value);
    }
  });

  test('compares ids by normalized canonical value', () => {
    expect(userIdsEqual('Lena@HybridAI', 'lena@hybridai')).toBe(true);
    expect(userIdsEqual('lena@hybridai', 'lena@local')).toBe(false);
    expect(compareUserIds('b@hybridai', 'a@hybridai')).toBeGreaterThan(0);
    expect(compareUserIds('a@hybridai', 'b@hybridai')).toBeLessThan(0);
  });

  test('exposes reserved authority names', () => {
    expect(isReservedUserAuthority('HybridAI')).toBe(true);
    expect(isReservedUserAuthority('local')).toBe(true);
    expect(isReservedUserAuthority('example')).toBe(false);
  });

  test('rejects invalid inputs', () => {
    const invalidValues = [
      '',
      'lena',
      'lena@',
      '@hybridai',
      'lena@@hybridai',
      'lena@hybridai@extra',
      'lena smith@hybridai',
      'lena@hybrid ai',
      '.lena@hybridai',
      'lena@-authority',
      'lena@hybridai!',
    ];

    for (const value of invalidValues) {
      expect(() => parseUserId(value), value).toThrow(UserIdValidationError);
    }
  });
});
