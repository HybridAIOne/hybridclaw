import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshDiscordWebhook(
  config?: Record<string, unknown>,
  options?: {
    sleep?: (ms: number) => Promise<void>;
  },
) {
  vi.resetModules();
  if (options?.sleep) {
    vi.doMock('../src/utils/sleep.js', () => ({
      sleep: options.sleep,
    }));
  }
  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: () => ({
      discordWebhook: config ?? {
        enabled: true,
        webhooks: {
          default: {
            webhookUrl:
              'https://discord.com/api/webhooks/123456789012345678/TOKEN',
            defaultUsername: '',
            defaultAvatarUrl: '',
          },
        },
      },
    }),
  }));
  return {
    target: await import('../src/channels/discord-webhook/target.js'),
    delivery: await import('../src/channels/discord-webhook/delivery.js'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/utils/sleep.js');
});

describe('Discord webhook channel', () => {
  test('normalizes target selectors and rejects invalid Discord webhook URLs without echoing them', async () => {
    const { target } = await importFreshDiscordWebhook();

    expect(target.normalizeDiscordWebhookChannelTarget('discord_webhook')).toBe(
      'discord_webhook:default',
    );
    expect(
      target.normalizeDiscordWebhookChannelTarget('discord-webhook:ops'),
    ).toBe('discord_webhook:ops');
    expect(
      target.normalizeDiscordWebhookChannelTarget('discord_webhook:bad/name'),
    ).toBeNull();
    expect(
      target.normalizeDiscordWebhookUrl(
        'https://user:pass@discord.com/api/webhooks/123/TOKEN?wait=true#frag',
      ),
    ).toBe('https://discord.com/api/webhooks/123/TOKEN');
    expect(target.discordWebhookSecretNameForTarget('default')).toBe(
      'DISCORD_WEBHOOK_URL',
    );
    expect(target.discordWebhookSecretNameForTarget('ops-team')).not.toBe(
      target.discordWebhookSecretNameForTarget('ops_team'),
    );

    const secretUrl = 'https://example.com/api/webhooks/123/TOKEN';
    expect(() => target.normalizeDiscordWebhookUrl(secretUrl)).toThrow(
      'valid Discord Incoming Webhook URL',
    );
    try {
      target.normalizeDiscordWebhookUrl(secretUrl);
    } catch (error) {
      expect(
        error instanceof Error ? error.message : String(error),
      ).not.toContain(secretUrl);
    }
  });

  test('builds Discord webhook content chunks no longer than 2000 chars', async () => {
    const { delivery } = await importFreshDiscordWebhook();
    const payloads = delivery.buildDiscordWebhookPayloads('a'.repeat(4_500), {
      defaultUsername: 'HybridClaw',
      defaultAvatarUrl: 'https://example.com/avatar.png',
    });

    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.every((payload) => payload.content.length <= 2_000)).toBe(
      true,
    );
    expect(payloads[0]).toMatchObject({
      username: 'HybridClaw',
      avatar_url: 'https://example.com/avatar.png',
      allowed_mentions: { parse: [] },
    });
  });

  test('posts Discord webhook JSON to the resolved target URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 204,
      headers: { get: () => null },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { delivery } = await importFreshDiscordWebhook({
      enabled: true,
      webhooks: {
        default: {
          webhookUrl:
            'https://discord.com/api/webhooks/123456789012345678/TOKEN',
          defaultUsername: 'HybridClaw',
          defaultAvatarUrl: '',
        },
      },
    });

    await delivery.sendDiscordWebhookText({
      target: 'discord_webhook',
      text: '**hello**',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123456789012345678/TOKEN',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"content"'),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      content: '**hello**',
      username: 'HybridClaw',
      allowed_mentions: { parse: [] },
    });
  });

  test('retries Discord webhook 429s using JSON retry_after body delays', async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ retry_after: 0.25 }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { delivery } = await importFreshDiscordWebhook(undefined, { sleep });

    await delivery.sendDiscordWebhookText({
      target: 'discord_webhook',
      text: 'retry after body',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  test('records reachability pings separately from last send results', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 204,
      headers: { get: () => null },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { delivery } = await importFreshDiscordWebhook();

    const result = await delivery.pingDiscordWebhookTarget({
      target: 'discord_webhook',
    });

    expect(result).toMatchObject({
      target: 'default',
      ok: true,
      statusCode: 204,
      error: null,
    });
    expect(delivery.getDiscordWebhookLastSendResults()).toEqual([]);
    expect(delivery.getDiscordWebhookLastReachabilityResults()).toHaveLength(1);
  });

  test('adds a managed POST-only Discord webhook policy grant', async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-discord-webhook-policy-'),
    );
    const {
      allowDiscordWebhookInWorkspacePolicy,
      DISCORD_WEBHOOK_POLICY_PRESET,
    } = await import('../src/channels/discord-webhook/policy.js');

    const result = allowDiscordWebhookInWorkspacePolicy({
      workspacePath,
      webhookUrl: 'https://discord.com/api/webhooks/123/TOKEN',
    });
    const repeated = allowDiscordWebhookInWorkspacePolicy({
      workspacePath,
      webhookUrl: 'https://discord.com/api/webhooks/123/TOKEN',
    });
    const policyText = fs.readFileSync(result.policyPath, 'utf-8');

    expect(result.added).toBe(true);
    expect(repeated.added).toBe(false);
    expect(policyText).toContain('host: discord.com');
    expect(policyText).toContain('methods:');
    expect(policyText).toContain('- POST');
    expect(policyText).toContain('paths:');
    expect(policyText).toContain('- /api/webhooks/**');
    expect(policyText).toContain(
      `managed_by_preset: ${DISCORD_WEBHOOK_POLICY_PRESET}`,
    );
    expect(policyText).not.toContain('TOKEN');
  });
});
