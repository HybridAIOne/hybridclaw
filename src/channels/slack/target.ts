import { normalizeTrimmedString as normalizeValue } from '../../utils/normalized-strings.js';

const SLACK_TARGET_PREFIX_RE = /^slack:/i;
const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]{8,}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{8,}$/;
const SLACK_THREAD_TS_RE = /^\d{10}(?:\.\d+)?$/;

export interface ParsedSlackChannelTarget {
  target: string;
  channelId: string;
  threadTs: string | null;
}

export function normalizeSlackChannelId(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeValue(value).toUpperCase();
  if (!normalized || !SLACK_CHANNEL_ID_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

export function normalizeSlackUserId(
  value: string | null | undefined,
): string | null {
  const trimmed = normalizeValue(value).replace(/^slack:/i, '');
  const mentionMatch = trimmed.match(/^<@([UW][A-Z0-9]{8,})>$/i);
  const normalized = (mentionMatch?.[1] || trimmed).toUpperCase();
  if (!normalized || !SLACK_USER_ID_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

export function normalizeSlackThreadTs(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeValue(value);
  if (!normalized || !SLACK_THREAD_TS_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

export function buildSlackChannelTarget(
  channelId: string,
  threadTs?: string | null,
): string {
  const normalizedChannelId = normalizeSlackChannelId(channelId);
  if (!normalizedChannelId) {
    throw new Error(`Invalid Slack channel id: ${channelId}`);
  }
  const normalizedThreadTs = normalizeSlackThreadTs(threadTs);
  return normalizedThreadTs
    ? `slack:${normalizedChannelId}:${normalizedThreadTs}`
    : `slack:${normalizedChannelId}`;
}

export function parseSlackChannelTarget(
  value: string | null | undefined,
): ParsedSlackChannelTarget | null {
  const trimmed = normalizeValue(value);
  if (!trimmed) return null;

  const withoutPrefix = trimmed.replace(SLACK_TARGET_PREFIX_RE, '');
  const parts = withoutPrefix.split(':');
  if (parts.length < 1 || parts.length > 2) return null;

  const channelId = normalizeSlackChannelId(parts[0]);
  if (!channelId) return null;

  const threadTs = parts.length === 2 ? normalizeSlackThreadTs(parts[1]) : null;
  if (parts.length === 2 && !threadTs) return null;

  return {
    target: buildSlackChannelTarget(channelId, threadTs),
    channelId,
    threadTs,
  };
}

export function isSlackChannelTarget(
  value: string | null | undefined,
): boolean {
  return parseSlackChannelTarget(value) !== null;
}
