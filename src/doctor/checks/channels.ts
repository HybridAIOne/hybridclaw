import { getWhatsAppAuthStatus } from '../../channels/whatsapp/auth.js';
import {
  DISCORD_TOKEN,
  EMAIL_PASSWORD,
  getConfigSnapshot,
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
  TELEGRAM_BOT_TOKEN,
  THREEMA_GATEWAY_SECRET,
} from '../../config/config.js';
import type { DiagResult } from '../types.js';
import { makeResult, severityFrom } from '../utils.js';

export async function checkChannels(): Promise<DiagResult[]> {
  const config = getConfigSnapshot();
  const telegram = config.telegram;
  const threema = config.threema;
  const slackWebhook = config.slackWebhook ?? {
    enabled: false,
    webhooks: {},
  };
  const segments: string[] = [];
  const severities: DiagResult['severity'][] = [];

  if (String(DISCORD_TOKEN || '').trim()) {
    segments.push('Discord configured');
  } else if (Object.keys(config.discord.guilds).length > 0) {
    segments.push('Discord token missing');
    severities.push('error');
  }

  if (config.msteams.enabled) {
    if (
      String(MSTEAMS_APP_ID || '').trim() &&
      String(MSTEAMS_APP_PASSWORD || '').trim()
    ) {
      segments.push('Teams configured');
    } else {
      segments.push('Teams credentials incomplete');
      severities.push('error');
    }
  }

  if (config.email.enabled) {
    if (
      config.email.address.trim() &&
      config.email.imapHost.trim() &&
      config.email.smtpHost.trim() &&
      String(EMAIL_PASSWORD || '').trim()
    ) {
      segments.push('Email polling ready');
    } else {
      segments.push('Email configuration incomplete');
      severities.push('error');
    }
  }

  if (telegram?.enabled) {
    if (String(TELEGRAM_BOT_TOKEN || telegram.botToken || '').trim()) {
      segments.push('Telegram configured');
    } else {
      segments.push('Telegram token missing');
      severities.push('error');
    }
  }

  if (threema?.enabled) {
    if (
      threema.identity.trim() &&
      String(THREEMA_GATEWAY_SECRET || threema.secret || '').trim()
    ) {
      segments.push('Threema configured');
    } else {
      segments.push('Threema credentials incomplete');
      severities.push('error');
    }
  }

  if (slackWebhook.enabled) {
    const targetCount = Object.keys(slackWebhook.webhooks).length;
    if (slackWebhook.webhooks.default?.webhookUrl) {
      segments.push(
        `Slack webhook configured (${targetCount} target${targetCount === 1 ? '' : 's'})`,
      );
      const { checkSlackWebhookReachability } = await import(
        '../../channels/slack-webhook/runtime.js'
      );
      const reachabilityResults = await checkSlackWebhookReachability();
      const failed = reachabilityResults.filter((result) => !result.ok);
      if (failed.length > 0) {
        segments.push(
          `Slack webhook reachability failed (${failed
            .map((result) => result.target)
            .join(', ')})`,
        );
        severities.push('error');
      } else if (reachabilityResults.length > 0) {
        segments.push('Slack webhook reachability ok');
      }
    } else {
      segments.push('Slack webhook default target missing');
      severities.push('error');
    }
  }

  const whatsapp = await getWhatsAppAuthStatus();
  const whatsappExpected =
    config.whatsapp.dmPolicy !== 'disabled' ||
    config.whatsapp.groupPolicy !== 'disabled';
  if (whatsapp.linked) {
    segments.push('WhatsApp linked');
  } else if (whatsappExpected) {
    segments.push('WhatsApp not linked');
    severities.push(config.whatsapp.dmPolicy === 'pairing' ? 'warn' : 'error');
  }

  if (segments.length === 0) {
    return [
      makeResult(
        'channels',
        'Channels',
        'ok',
        'No external channels enabled (Discord, Teams, Telegram, Threema, Slack webhook, Email, and WhatsApp are all intentionally disabled)',
      ),
    ];
  }

  return [
    makeResult(
      'channels',
      'Channels',
      severityFrom(severities),
      segments.join(', '),
    ),
  ];
}
