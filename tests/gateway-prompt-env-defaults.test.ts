import { afterEach, describe, expect, test } from 'vitest';
import { validateGatewayPromptEnvDefaults } from '../src/gateway/gateway-chat-service.js';
import {
  GATEWAY_SYSTEM_PROMPT_MODE_ENV,
  GATEWAY_SYSTEM_PROMPT_PARTS_ENV,
  GATEWAY_TOOLS_MODE_ENV,
} from '../src/gateway/gateway-lifecycle.js';

const ENV_NAMES = [
  GATEWAY_SYSTEM_PROMPT_MODE_ENV,
  GATEWAY_SYSTEM_PROMPT_PARTS_ENV,
  GATEWAY_TOOLS_MODE_ENV,
];

describe('gateway prompt env defaults', () => {
  afterEach(() => {
    for (const envName of ENV_NAMES) {
      delete process.env[envName];
    }
  });

  test('accepts valid gateway prompt and tools defaults', () => {
    process.env[GATEWAY_SYSTEM_PROMPT_MODE_ENV] = 'minimal';
    process.env[GATEWAY_SYSTEM_PROMPT_PARTS_ENV] = 'soul,memory-file';
    process.env[GATEWAY_TOOLS_MODE_ENV] = 'none';

    expect(() => validateGatewayPromptEnvDefaults()).not.toThrow();
  });

  test('throws on invalid gateway system prompt mode default', () => {
    process.env[GATEWAY_SYSTEM_PROMPT_MODE_ENV] = 'minmal';

    expect(() => validateGatewayPromptEnvDefaults()).toThrow(
      /Invalid value for HYBRIDCLAW_SYSTEM_PROMPT_MODE: minmal/,
    );
  });

  test('throws on invalid gateway tools mode default', () => {
    process.env[GATEWAY_TOOLS_MODE_ENV] = 'disabled';

    expect(() => validateGatewayPromptEnvDefaults()).toThrow(
      /Invalid value for HYBRIDCLAW_TOOLS_MODE: disabled/,
    );
  });

  test('throws on invalid gateway prompt part defaults', () => {
    process.env[GATEWAY_SYSTEM_PROMPT_PARTS_ENV] = 'soul,bogus';

    expect(() => validateGatewayPromptEnvDefaults()).toThrow(
      /Invalid value for HYBRIDCLAW_SYSTEM_PROMPT_PARTS: Unknown prompt part/,
    );
  });
});
