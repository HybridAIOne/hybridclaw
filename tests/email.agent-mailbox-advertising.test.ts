import { describe, expect, it } from 'vitest';
import { resolveAgentOwnEmailAddress } from '../src/channels/email/agent-account.js';
import { describeMessageToolChannelActions } from '../src/channels/message-tool-advertising.js';
import type {
  RuntimeConfig,
  RuntimeEmailAccountConfig,
} from '../src/config/runtime-config.js';

function account(agentId: string, address: string): RuntimeEmailAccountConfig {
  return { agentId, address } as RuntimeEmailAccountConfig;
}

function config(
  email: Partial<RuntimeConfig['email']>,
): Pick<RuntimeConfig, 'email' | 'agents'> {
  return {
    email: {
      enabled: true,
      address: '',
      accounts: [],
      ...email,
    } as RuntimeConfig['email'],
    agents: { channels: { email: 'main' } } as RuntimeConfig['agents'],
  };
}

describe('resolveAgentOwnEmailAddress', () => {
  it.each([
    {
      name: 'the email channel agent owns the top-level mailbox',
      email: { address: 'main@example.com' },
      agentId: 'main',
      expected: 'main@example.com',
    },
    {
      name: 'another agent without an account has none',
      email: { address: 'main@example.com' },
      agentId: 'research',
      expected: null,
    },
    {
      name: 'an account entry gives the agent its own mailbox',
      email: {
        address: 'main@example.com',
        accounts: [account('research', 'research@example.com')],
      },
      agentId: 'research',
      expected: 'research@example.com',
    },
    {
      name: 'an account without an agent belongs to the email channel agent',
      email: { accounts: [account('', 'shared@example.com')] },
      agentId: 'main',
      expected: 'shared@example.com',
    },
    {
      name: 'a top-level address moved to another agent is not the channel agent’s',
      email: {
        address: 'main@example.com',
        accounts: [account('research', 'MAIN@example.com')],
      },
      agentId: 'main',
      expected: null,
    },
    {
      name: 'a disabled email channel gives nobody a mailbox',
      email: { enabled: false, address: 'main@example.com' },
      agentId: 'main',
      expected: null,
    },
  ])('$name', ({ email, agentId, expected }) => {
    expect(resolveAgentOwnEmailAddress(config(email), agentId)).toBe(expected);
  });
});

describe('describeMessageToolChannelActions email line', () => {
  it('names the address of an agent with its own mailbox', () => {
    const [line] = describeMessageToolChannelActions(
      ['email'],
      'research@example.com',
    );
    expect(line).toContain('research@example.com');
    expect(line).not.toContain('no mailbox');
  });

  it('says an agent without a mailbox sends from the shared one', () => {
    const [line] = describeMessageToolChannelActions(['email'], null);
    expect(line).toContain('no mailbox of its own');
    expect(line).not.toContain('own mailbox,');
  });
});
