import { afterEach, describe, expect, it, test, vi } from 'vitest';
import { normalizeQuestions } from '../container/src/tools/questions.js';
import {
  buildMailSenderPromptLines,
  buildMailSenderQuestions,
  listMailSenders,
  MAIL_SENDER_QUESTION,
  type MailConnectorState,
  type MailSender,
} from '../src/agent/mail-senders.js';
import { buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';
import { EMAIL_CAPABILITIES } from '../src/channels/channel.js';
import {
  registerChannel,
  unregisterChannel,
} from '../src/channels/channel-registry.js';
import { resolveAgentSenderEmailAddress } from '../src/channels/email/agent-account.js';
import * as runtimeConfig from '../src/config/runtime-config.js';
import type {
  RuntimeConfig,
  RuntimeEmailAccountConfig,
} from '../src/config/runtime-config.js';
import { parseConnectorDirectory } from '../src/scopes/scope-connectors.js';

function connector(
  id: string,
  connected: boolean,
  account: string | null = null,
): MailConnectorState {
  return { id, kind: 'connector', connected, account };
}

const offered = () => true;
const agentMailbox = { address: 'hy@agents.example.com', own: true };

describe('listMailSenders', () => {
  it.each([
    {
      name: 'the agent mailbox alone',
      input: { agentEmail: agentMailbox, connectors: null },
      expected: [{ kind: 'agent', address: 'hy@agents.example.com' }],
    },
    {
      name: 'a shared default mailbox is marked as shared',
      input: {
        agentEmail: { address: 'team@example.com', own: false },
        connectors: [],
      },
      expected: [{ kind: 'shared', address: 'team@example.com' }],
    },
    {
      name: 'connected Google and Microsoft accounts follow the agent mailbox',
      input: {
        agentEmail: agentMailbox,
        connectors: [
          connector('microsoft365', true),
          connector('google', true, 'pat@example.com'),
        ],
      },
      expected: [
        { kind: 'agent', address: 'hy@agents.example.com' },
        { kind: 'google', address: 'pat@example.com' },
        { kind: 'microsoft365', address: null },
      ],
    },
    {
      name: 'a connector the user has not signed in to is no sender',
      input: {
        agentEmail: agentMailbox,
        connectors: [connector('google', false)],
      },
      expected: [{ kind: 'agent', address: 'hy@agents.example.com' }],
    },
    {
      name: 'connectors that cannot send mail are no sender',
      input: {
        agentEmail: null,
        connectors: [
          connector('mailbox', true, 'pat@example.com'),
          connector('github', true, 'pat'),
        ],
      },
      expected: [],
    },
  ])('$name', ({ input, expected }) => {
    expect(listMailSenders({ ...input, isToolOffered: offered })).toEqual(
      expected,
    );
  });

  test('a connector whose tools the chat blocks is no sender', () => {
    const senders = listMailSenders({
      agentEmail: agentMailbox,
      connectors: [connector('google', true), connector('microsoft365', true)],
      isToolOffered: (toolName) => !toolName.startsWith('hybridai__google__'),
    });
    expect(senders.map((sender) => sender.kind)).toEqual([
      'agent',
      'microsoft365',
    ]);
  });
});

describe('the mail sender card', () => {
  const senders: MailSender[] = [
    { kind: 'agent', address: 'hy@agents.example.com' },
    { kind: 'google', address: 'pat@example.com' },
    { kind: 'microsoft365', address: null },
  ];

  test('has one option per account and is valid `ask_questions` input', () => {
    const payload = buildMailSenderQuestions(senders);
    expect(payload).toEqual({
      questions: [
        {
          question: MAIL_SENDER_QUESTION,
          options: ['hy@agents.example.com', 'pat@example.com', 'Outlook'],
        },
      ],
    });
    expect(
      normalizeQuestions(payload as unknown as Record<string, unknown>),
    ).toEqual(payload?.questions);
  });

  it.each([
    { name: 'one account', senders: senders.slice(0, 1) },
    {
      name: 'two accounts the card cannot tell apart',
      senders: [
        { kind: 'agent', address: 'Pat@example.com' },
        { kind: 'google', address: 'pat@example.com' },
      ] satisfies MailSender[],
    },
    {
      name: 'an address longer than a card option',
      senders: [
        senders[0],
        { kind: 'google', address: `${'p'.repeat(80)}@example.com` },
      ] satisfies MailSender[],
    },
  ])('is not built for $name', ({ senders: given }) => {
    expect(buildMailSenderQuestions(given)).toBeNull();
  });

  test('the prompt hands the model the card payload when the card is offered', () => {
    const lines = buildMailSenderPromptLines(senders, { card: true });
    const prompt = lines.join('\n');
    const json = prompt.match(/`ask_questions` with (\{.*?\}), the question/);
    expect(JSON.parse(json?.[1] ?? 'null')).toEqual(
      buildMailSenderQuestions(senders),
    );
    for (const option of ['hy@agents.example.com', 'pat@example.com', 'Outlook']) {
      expect(prompt).toContain(`- \`${option}\`:`);
    }
  });

  test('without the card the model asks in words', () => {
    const prompt = buildMailSenderPromptLines(senders, { card: false }).join(
      '\n',
    );
    expect(prompt).toContain('hy@agents.example.com');
    expect(prompt).not.toContain('ask_questions');
  });

  test('a single account means no question at all', () => {
    expect(
      buildMailSenderPromptLines(senders.slice(0, 1), { card: true }),
    ).toEqual([]);
  });
});

function emailConfig(
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

function account(agentId: string, address: string): RuntimeEmailAccountConfig {
  return { agentId, address } as RuntimeEmailAccountConfig;
}

describe('resolveAgentSenderEmailAddress', () => {
  it.each([
    {
      name: 'an agent with its own mailbox sends from it',
      email: { accounts: [account('research', 'research@example.com')] },
      agentId: 'research',
      expected: { address: 'research@example.com', own: true },
    },
    {
      name: 'an agent without one sends from the top-level mailbox',
      email: { address: 'main@example.com' },
      agentId: 'research',
      expected: { address: 'main@example.com', own: false },
    },
    {
      name: 'the first account replaces a top-level mailbox it takes over',
      email: {
        address: 'main@example.com',
        accounts: [account('', 'support@example.com')],
      },
      agentId: 'research',
      expected: { address: 'support@example.com', own: false },
    },
    {
      name: 'the top-level mailbox stays first beside other agents’ accounts',
      email: {
        address: 'main@example.com',
        accounts: [account('sales', 'sales@example.com')],
      },
      agentId: 'research',
      expected: { address: 'main@example.com', own: false },
    },
    {
      name: 'a disabled email channel sends nothing',
      email: { enabled: false, address: 'main@example.com' },
      agentId: 'main',
      expected: null,
    },
  ])('$name', ({ email, agentId, expected }) => {
    expect(
      resolveAgentSenderEmailAddress(emailConfig(email), agentId),
    ).toEqual(expected);
  });
});

test('the platform directory says which connectors are signed in and as whom', () => {
  expect(
    parseConnectorDirectory({
      connectors: [
        { id: 'google', kind: 'connector', connected: true },
        {
          id: 'mailbox',
          kind: 'connector',
          connected: true,
          account: { address: 'pat@example.com' },
        },
        { id: 'x', kind: 'connector', connected: false, account: 'pat' },
        { id: 'dm', kind: 'tool', connected: true },
      ],
    }),
  ).toEqual([
    { id: 'google', kind: 'connector', connected: true, account: null },
    {
      id: 'mailbox',
      kind: 'connector',
      connected: true,
      account: 'pat@example.com',
    },
    { id: 'x', kind: 'connector', connected: false, account: 'pat' },
    { id: 'dm', kind: 'tool', connected: true, account: null },
  ]);
});

describe('the system prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    unregisterChannel('email');
  });

  function prompt(client: 'mobile' | undefined, connected: boolean): string {
    const original = runtimeConfig.getRuntimeConfig();
    vi.spyOn(runtimeConfig, 'getRuntimeConfig').mockReturnValue({
      ...original,
      email: {
        ...original.email,
        enabled: true,
        address: 'hy@agents.example.com',
        accounts: [],
      },
      agents: {
        ...original.agents,
        channels: { ...original.agents.channels, email: 'test-agent' },
      },
    });
    registerChannel({
      kind: 'email',
      id: 'hy@agents.example.com',
      capabilities: EMAIL_CAPABILITIES,
    });
    return buildSystemPromptFromHooks({
      agentId: 'test-agent',
      skills: [],
      runtimeInfo: { channelId: 'web', ...(client ? { client } : {}) },
      ...(client ? {} : { blockedTools: ['ask_questions'] }),
      mailConnectors: [connector('google', connected)],
    });
  }

  test('in the app it offers the card with both accounts', () => {
    const text = prompt('mobile', true);
    expect(text).toContain(
      JSON.stringify(
        buildMailSenderQuestions([
          { kind: 'agent', address: 'hy@agents.example.com' },
          { kind: 'google', address: null },
        ]),
      ),
    );
  });

  test('where the card is blocked it asks in words', () => {
    const text = prompt(undefined, true);
    expect(text).toContain('- `Gmail`:');
    expect(text).not.toContain('`ask_questions` with');
  });

  test('with only the agent mailbox it says nothing about choosing', () => {
    expect(prompt('mobile', false)).not.toContain(MAIL_SENDER_QUESTION);
  });
});
