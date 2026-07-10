import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshSlackWebhook(config?: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      slackWebhook: config ?? {
        enabled: true,
        webhooks: {
          default: {
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/SECRET',
            defaultUsername: '',
            defaultIconEmoji: '',
            defaultIconUrl: '',
          },
        },
      },
    }),
  }));
  return {
    target: await import('../src/channels/slack-webhook/target.js'),
    delivery: await import('../src/channels/slack-webhook/delivery.js'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.js');
});

describe('Slack webhook channel', () => {
  test('normalizes target selectors and rejects invalid Slack webhook URLs without echoing them', async () => {
    const { target } = await importFreshSlackWebhook();

    expect(target.normalizeSlackWebhookChannelTarget('slack_webhook')).toBe(
      'slack_webhook:default',
    );
    expect(target.normalizeSlackWebhookChannelTarget('slack-webhook:ops')).toBe(
      'slack_webhook:ops',
    );
    expect(
      target.normalizeSlackWebhookChannelTarget('slack_webhook:bad/name'),
    ).toBeNull();
    expect(
      target.normalizeSlackWebhookUrl(
        'https://user:pass@hooks.slack.com/services/T000/B000/SECRET?debug=1#frag',
      ),
    ).toBe('https://hooks.slack.com/services/T000/B000/SECRET');
    expect(target.slackWebhookSecretNameForTarget('default')).toBe(
      'SLACK_WEBHOOK_URL',
    );
    expect(target.slackWebhookSecretNameForTarget('ops-team')).not.toBe(
      target.slackWebhookSecretNameForTarget('ops_team'),
    );

    const secretUrl = 'https://example.com/services/T000/B000/SECRET';
    expect(() => target.normalizeSlackWebhookUrl(secretUrl)).toThrow(
      'valid Slack Incoming Webhook URL',
    );
    try {
      target.normalizeSlackWebhookUrl(secretUrl);
    } catch (error) {
      expect(
        error instanceof Error ? error.message : String(error),
      ).not.toContain(secretUrl);
    }
  });

  test('keeps Block Kit section chunks below the hard text limit', async () => {
    const { delivery } = await importFreshSlackWebhook();
    const payload = delivery.buildSlackWebhookPayload('a'.repeat(6_500), {
      defaultUsername: 'HybridClaw',
      defaultIconEmoji: ':robot_face:',
    });

    expect(payload.text.length).toBeGreaterThan(6_000);
    expect(payload.username).toBe('HybridClaw');
    expect(payload.icon_emoji).toBe(':robot_face:');
    expect(payload.blocks.length).toBeGreaterThan(1);
    expect(
      payload.blocks.every((block) => block.text.text.length <= 2_900),
    ).toBe(true);
  });

  test('posts Slack webhook JSON to the resolved target URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { delivery } = await importFreshSlackWebhook({
      enabled: true,
      webhooks: {
        default: {
          webhookUrl: 'https://hooks.slack.com/services/T000/B000/SECRET',
          defaultUsername: 'HybridClaw',
          defaultIconEmoji: '',
          defaultIconUrl: '',
        },
      },
    });

    await delivery.sendSlackWebhookText({
      target: 'slack_webhook',
      text: '**hello**',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/T000/B000/SECRET',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"blocks"'),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      text: '*hello*',
      username: 'HybridClaw',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*hello*' },
        },
      ],
    });
  });

  test('records reachability pings separately from last send results', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { delivery } = await importFreshSlackWebhook();

    const result = await delivery.pingSlackWebhookTarget({
      target: 'slack_webhook',
    });

    expect(result).toMatchObject({
      target: 'default',
      ok: true,
      statusCode: 200,
      error: null,
    });
    expect(delivery.getSlackWebhookLastSendResults()).toEqual([]);
    expect(delivery.getSlackWebhookLastReachabilityResults()).toHaveLength(1);
  });

  test('adds a managed POST-only Slack webhook policy grant', async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-slack-webhook-policy-'),
    );
    const { allowSlackWebhookInWorkspacePolicy, SLACK_WEBHOOK_POLICY_PRESET } =
      await import('../src/channels/slack-webhook/policy.js');

    const result = allowSlackWebhookInWorkspacePolicy({
      workspacePath,
      webhookUrl: 'https://hooks.slack.com/services/T000/B000/SECRET',
    });
    const repeated = allowSlackWebhookInWorkspacePolicy({
      workspacePath,
      webhookUrl: 'https://hooks.slack.com/services/T000/B000/SECRET',
    });
    const policyText = fs.readFileSync(result.policyPath, 'utf-8');

    expect(result.added).toBe(true);
    expect(repeated.added).toBe(false);
    expect(policyText).toContain('host: hooks.slack.com');
    expect(policyText).toContain('methods:');
    expect(policyText).toContain('- POST');
    expect(policyText).toContain('paths:');
    expect(policyText).toContain('- /services/**');
    expect(policyText).toContain(
      `managed_by_preset: ${SLACK_WEBHOOK_POLICY_PRESET}`,
    );
    expect(policyText).not.toContain('SECRET');
  });
});
