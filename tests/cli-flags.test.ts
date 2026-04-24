import { describe, expect, it } from 'vitest';

import {
  findUnsupportedGatewayLifecycleFlag,
  parseGatewayFlags,
} from '../src/config/cli-flags.js';

describe('parseGatewayFlags', () => {
  it('parses gateway lifecycle flags without sandbox override', () => {
    expect(parseGatewayFlags(['--foreground'])).toEqual({
      debug: false,
      debugModelResponses: false,
      foreground: true,
      help: false,
      logRequests: false,
      systemPromptMode: null,
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: null,
      sandboxMode: null,
    });
  });

  it('parses equals-style sandbox override', () => {
    expect(
      parseGatewayFlags(['--foreground', '--debug', '--sandbox=host']),
    ).toEqual({
      debug: true,
      debugModelResponses: false,
      foreground: true,
      help: false,
      logRequests: false,
      systemPromptMode: null,
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: null,
      sandboxMode: 'host',
    });
  });

  it('parses split sandbox override', () => {
    expect(parseGatewayFlags(['--sandbox', 'container'])).toEqual({
      debug: false,
      debugModelResponses: false,
      foreground: false,
      help: false,
      logRequests: false,
      systemPromptMode: null,
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: null,
      sandboxMode: 'container',
    });
  });

  it('parses help without starting the command', () => {
    expect(parseGatewayFlags(['--help'])).toEqual({
      debug: false,
      debugModelResponses: false,
      foreground: false,
      help: true,
      logRequests: false,
      systemPromptMode: null,
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: null,
      sandboxMode: null,
    });
  });

  it('parses request logging flag', () => {
    expect(parseGatewayFlags(['--log-requests'])).toEqual({
      debug: false,
      debugModelResponses: false,
      foreground: false,
      help: false,
      logRequests: true,
      systemPromptMode: null,
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: null,
      sandboxMode: null,
    });
  });

  it('parses model response debug logging flag', () => {
    expect(parseGatewayFlags(['--debug-model-responses'])).toEqual({
      debug: false,
      debugModelResponses: true,
      foreground: false,
      help: false,
      logRequests: false,
      systemPromptMode: null,
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: null,
      sandboxMode: null,
    });
  });

  it('parses gateway system prompt include and exclude parts', () => {
    expect(
      parseGatewayFlags([
        '--system-prompt=soul,memory-file',
        '--system-prompt-exclude',
        'runtime',
      ]),
    ).toEqual({
      debug: false,
      debugModelResponses: false,
      foreground: false,
      help: false,
      logRequests: false,
      systemPromptMode: null,
      systemPromptParts: ['soul', 'memory-file'],
      systemPromptExcludeParts: ['runtime'],
      toolsMode: null,
      sandboxMode: null,
    });
  });

  it('parses system prompt mode values', () => {
    expect(parseGatewayFlags(['--system-prompt=none'])).toEqual({
      debug: false,
      debugModelResponses: false,
      foreground: false,
      help: false,
      logRequests: false,
      systemPromptMode: 'none',
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: null,
      sandboxMode: null,
    });
  });

  it('parses tools mode values', () => {
    expect(parseGatewayFlags(['--tools=none'])).toEqual({
      debug: false,
      debugModelResponses: false,
      foreground: false,
      help: false,
      logRequests: false,
      systemPromptMode: null,
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: 'none',
      sandboxMode: null,
    });
    expect(parseGatewayFlags(['--no-tools'])).toEqual({
      debug: false,
      debugModelResponses: false,
      foreground: false,
      help: false,
      logRequests: false,
      systemPromptMode: null,
      systemPromptParts: [],
      systemPromptExcludeParts: [],
      toolsMode: 'none',
      sandboxMode: null,
    });
  });

  it('throws on unknown gateway system prompt parts', () => {
    expect(() => parseGatewayFlags(['--system-prompt=bogus'])).toThrow(
      /Unknown prompt part/,
    );
  });

  it('throws on invalid tools mode values', () => {
    expect(() => parseGatewayFlags(['--tools=weird'])).toThrow(
      /Invalid value for --tools/,
    );
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
    expect(
      findUnsupportedGatewayLifecycleFlag([
        'status',
        '--debug-model-responses',
      ]),
    ).toBe('debug-model-responses');
    expect(
      findUnsupportedGatewayLifecycleFlag(['status', '--system-prompt=soul']),
    ).toBe('system-prompt');
    expect(
      findUnsupportedGatewayLifecycleFlag([
        'status',
        '--system-prompt-exclude=soul',
      ]),
    ).toBe('system-prompt-exclude');
    expect(
      findUnsupportedGatewayLifecycleFlag(['status', '--tools=none']),
    ).toBe('tools');
    expect(findUnsupportedGatewayLifecycleFlag(['status', '--no-tools'])).toBe(
      'no-tools',
    );
    expect(findUnsupportedGatewayLifecycleFlag(['--sandbox=host'])).toBe(
      'sandbox',
    );
  });
});
