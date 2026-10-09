import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ApprovalMode } from '../container/shared/approval-mode.js';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import {
  approvalReviewArguments,
  setApprovalEmailSender,
  setUserMailContext,
} from '../container/src/approval-review.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-message-send-approval-');
useCleanMocks({ unstubAllEnvs: true });
afterEach(() => {
  setApprovalEmailSender(undefined);
  setUserMailContext({ toolNames: [] });
});

function createRuntime(mode: ApprovalMode = 'auto') {
  const dir = makeTempDir();
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(dir, 'policy.yaml'),
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setApprovalMode({ mode });
  return runtime;
}

const invitation = {
  action: 'send',
  channelId: 'pat@example.com',
  subject: 'Friday',
  content: 'See you then.',
};

function send(runtime: TrustedAgentApprovalRuntime, args: object) {
  return runtime.evaluateToolCall({
    toolName: 'message',
    argsJson: JSON.stringify(args),
    latestUserPrompt: 'Tell Pat I can make Friday',
  });
}

describe('message tool sends', () => {
  test('an email send asks first in the default mode', () => {
    expect(send(createRuntime(), invitation)).toMatchObject({
      tier: 'red',
      decision: 'required',
      actionKey: 'message:send:pat@example.com',
      intent: 'send an email to pat@example.com',
      reason: 'this sends an email in your name',
    });
  });

  test('a send to another chat asks first too', () => {
    expect(
      send(createRuntime(), {
        action: 'send',
        channelId: 'telegram:12345',
        content: 'On my way',
      }),
    ).toMatchObject({ tier: 'red', decision: 'required' });
  });

  test('a reply in the current conversation still runs', () => {
    expect(
      send(createRuntime(), { action: 'send', content: 'Done.' }).decision,
    ).not.toBe('required');
  });

  test('an email without a subject goes back to the model', () => {
    const { subject: _subject, ...withoutSubject } = invitation;
    expect(send(createRuntime(), withoutSubject)).toMatchObject({
      decision: 'denied',
      reason:
        'an email needs a subject the user can see before it is sent; call again with subject',
    });
    expect(send(createRuntime('full'), withoutSubject).decision).toBe(
      'denied',
    );
  });

  test("with the user's own mail account, the agent's mailbox never sends", () => {
    setUserMailContext({
      toolNames: ['message', 'hybridai__google__send_mail', 'read'],
    });
    expect(send(createRuntime(), invitation)).toMatchObject({
      decision: 'denied',
      reason:
        "this would send from the agent's own mailbox, not the user's; send it from the user's account with hybridai__google__send_mail",
    });
    expect(send(createRuntime('full'), invitation).decision).toBe('denied');
  });

  test('from the phone app without a mail account, the user connects one first', () => {
    setUserMailContext({ toolNames: ['message'], client: 'mobile' });
    expect(send(createRuntime(), invitation)).toMatchObject({
      decision: 'denied',
      reason:
        "this would send from the agent's own mailbox, not the user's; ask the user to connect their mail account first",
    });
  });

  test('reads stay green', () => {
    expect(
      send(createRuntime(), { action: 'read', channelId: 'email:inbox' }).tier,
    ).toBe('green');
  });
});

describe('message tool email review', () => {
  test('carries the email as the card shows it', () => {
    setApprovalEmailSender('hy@example.com');
    const review = approvalReviewArguments(
      'message',
      JSON.stringify({ ...invitation, cc: ['me@example.com'] }),
    );
    expect(JSON.parse(review ?? '{}')).toEqual({
      transport: 'email',
      from: 'hy@example.com',
      to: ['pat@example.com'],
      cc: ['me@example.com'],
      subject: 'Friday',
      body: 'See you then.',
    });
  });

  test('is absent for chat sends', () => {
    expect(
      approvalReviewArguments(
        'message',
        JSON.stringify({ action: 'send', channelId: 'telegram:1', content: 'x' }),
      ),
    ).toBeUndefined();
  });
});
