import { describe, expect, it } from 'vitest';
import { redactSecretCommand } from './redact-secret-command';

const MASK = '••••••';

describe('redactSecretCommand', () => {
  it('masks the value of a /secret set command', () => {
    expect(redactSecretCommand('/secret set TS_AUTHKEY tskey-abc123')).toBe(
      `/secret set TS_AUTHKEY ${MASK}`,
    );
  });

  it('masks the value without a leading slash', () => {
    expect(redactSecretCommand('secret set API_TOKEN hunter2')).toBe(
      `secret set API_TOKEN ${MASK}`,
    );
  });

  it('masks values containing spaces or quotes wholesale', () => {
    expect(redactSecretCommand('/secret set NAME "multi word value"')).toBe(
      `/secret set NAME ${MASK}`,
    );
    expect(redactSecretCommand('/secret set NAME part1 part2 part3')).toBe(
      `/secret set NAME ${MASK}`,
    );
  });

  it('is case-insensitive on the command keywords', () => {
    expect(redactSecretCommand('/SECRET SET NAME value')).toBe(
      `/SECRET SET NAME ${MASK}`,
    );
  });

  it('preserves surrounding whitespace before the command', () => {
    expect(redactSecretCommand('  /secret set NAME value')).toBe(
      `  /secret set NAME ${MASK}`,
    );
  });

  it('masks a multi-line secret value through the end of the message', () => {
    // The gateway joins everything after <NAME> (newlines included) into the
    // stored value, so continuation lines must be masked too — not just the
    // first line.
    expect(redactSecretCommand('/secret set NAME line1\nline2')).toBe(
      `/secret set NAME ${MASK}`,
    );
    expect(redactSecretCommand('/secret set NAME\nvalue')).toBe(
      `/secret set NAME\n${MASK}`,
    );
  });

  it('leaves a secret-set that is not at the start of the message unchanged', () => {
    // Only a message beginning with the command is parsed as a secret command,
    // so mid-message text is not a stored secret and is left exactly as typed.
    const text = 'before\n/secret set NAME value\nafter';
    expect(redactSecretCommand(text)).toBe(text);
  });

  it('leaves non-value secret subcommands unchanged', () => {
    for (const command of [
      '/secret list',
      '/secret show TS_AUTHKEY',
      '/secret unset TS_AUTHKEY',
      '/secret route add https://api.example.com/ TS_AUTHKEY',
    ]) {
      expect(redactSecretCommand(command)).toBe(command);
    }
  });

  it('leaves an incomplete set command (no value) unchanged', () => {
    expect(redactSecretCommand('/secret set TS_AUTHKEY')).toBe(
      '/secret set TS_AUTHKEY',
    );
    expect(redactSecretCommand('/secret set TS_AUTHKEY   ')).toBe(
      '/secret set TS_AUTHKEY   ',
    );
  });

  it('leaves ordinary messages unchanged', () => {
    expect(
      redactSecretCommand('what is the secret to a good set of tests?'),
    ).toBe('what is the secret to a good set of tests?');
    expect(redactSecretCommand('hello world')).toBe('hello world');
  });
});
