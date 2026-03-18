import { describe, expect, it } from 'vitest';

import {
  findUnsupportedGatewayLifecycleFlag,
  parseGatewayFlags,
} from '../src/config/cli-flags.js';

describe('parseGatewayFlags', () => {
  it('parses gateway lifecycle flags without sandbox override', () => {
    expect(parseGatewayFlags(['--foreground'])).toEqual({
      debug: false,
      foreground: true,
      help: false,
      logRequests: false,
      sandboxMode: null,
    });
  });

  it('parses equals-style sandbox override', () => {
    expect(
      parseGatewayFlags(['--foreground', '--debug', '--sandbox=host']),
    ).toEqual({
      debug: true,
      foreground: true,
      help: false,
      logRequests: false,
      sandboxMode: 'host',
    });
  });

  it('parses split sandbox override', () => {
    expect(parseGatewayFlags(['--sandbox', 'container'])).toEqual({
      debug: false,
      foreground: false,
      help: false,
      logRequests: false,
      sandboxMode: 'container',
    });
  });

  it('parses help without starting the command', () => {
    expect(parseGatewayFlags(['--help'])).toEqual({
      debug: false,
      foreground: false,
      help: true,
      logRequests: false,
      sandboxMode: null,
    });
  });

  it('parses request logging flag', () => {
    expect(parseGatewayFlags(['--log-requests'])).toEqual({
      debug: false,
      foreground: false,
      help: false,
      logRequests: true,
      sandboxMode: null,
    });
  });

  it('throws on invalid sandbox override', () => {
    expect(() => parseGatewayFlags(['--sandbox=weird'])).toThrow(
      /Invalid value for --sandbox/,
    );
  });
});

describe('findUnsupportedGatewayLifecycleFlag', () => {
  it('allows lifecycle flags on start and restart', () => {
    expect(
      findUnsupportedGatewayLifecycleFlag(['start', '--sandbox=host']),
    ).toBeNull();
    expect(findUnsupportedGatewayLifecycleFlag(['restart', '-f'])).toBeNull();
  });

  it('rejects lifecycle flags on other gateway subcommands', () => {
    expect(
      findUnsupportedGatewayLifecycleFlag(['status', '--sandbox=host']),
    ).toBe('sandbox');
    expect(findUnsupportedGatewayLifecycleFlag(['sessions', '-f'])).toBe(
      'foreground',
    );
    expect(findUnsupportedGatewayLifecycleFlag(['status', '--debug'])).toBe(
      'debug',
    );
    expect(
      findUnsupportedGatewayLifecycleFlag(['status', '--log-requests']),
    ).toBe('log-requests');
    expect(findUnsupportedGatewayLifecycleFlag(['--sandbox=host'])).toBe(
      'sandbox',
    );
  });
});
