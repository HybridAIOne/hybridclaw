import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './error-message';

describe('getErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns fallback for Error with empty message', () => {
    expect(getErrorMessage(new Error())).toBe('An unexpected error occurred.');
    expect(getErrorMessage(new Error(''))).toBe(
      'An unexpected error occurred.',
    );
  });

  it('returns strings as-is', () => {
    expect(getErrorMessage('something broke')).toBe('something broke');
  });

  it('extracts .message from plain objects', () => {
    expect(getErrorMessage({ message: 'Unauthorized' })).toBe('Unauthorized');
    expect(getErrorMessage({ message: 'rate limited', statusCode: 429 })).toBe(
      'rate limited',
    );
  });

  it('returns fallback for plain object with empty .message', () => {
    expect(getErrorMessage({ message: '' })).toBe(
      'An unexpected error occurred.',
    );
  });

  it('ignores .message if it is not a string', () => {
    expect(getErrorMessage({ message: 42 })).toBe('[object Object]');
  });

  it('stringifies null and undefined', () => {
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('stringifies numbers', () => {
    expect(getErrorMessage(404)).toBe('404');
  });
});
