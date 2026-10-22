/**
 * Discord delegate progress — one live message per delegation job.
 *
 * The first snapshot of a job posts a message; later snapshots edit it in
 * place (throttled under Discord's edit rate limit) and the finished snapshot
 * collapses it to a compact receipt. The delegate *results* are not posted
 * here: they arrive as a normal proactive message from the parent turn.
 *
 * Live handles are gateway memory only; after a restart the job is gone too.
 */
import type { Message as DiscordMessage } from 'discord.js';
import {
  distinctDelegateModels,
  formatDelegationTokenCount,
} from '../../gateway/delegation-format.js';
import type {
  DelegationStatusEntry,
  DelegationStatusSnapshot,
} from '../../gateway/delegation-plan.js';
import { logger } from '../../logger.js';
import { formatDuration, pluralize } from '../../utils/text-format.js';
import { discordRuntimeLoader } from '../channel-runtime-loaders.js';
import { withDiscordRetry } from './retry.js';

// 1.5s (owner call, 2026-10-21): stays under Discord's 5 edits / 5s per
// channel while the parent reply streams in the same channel.
const STATUS_EDIT_INTERVAL_MS = 1_500;

const ENTRY_ICONS: Record<DelegationStatusEntry['status'], string> = {
  queued: '🕒',
  running: '🔄',
  completed: '✅',
  failed: '❌',
  timeout: '⌛',
  blocked: '⛔',
};

type EditableMessage = Pick<DiscordMessage, 'edit'>;

interface LiveStatus {
  message: Promise<EditableMessage | undefined>;
  latest: string;
  shown: string;
  lastEditAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
}

const liveStatuses = new Map<string, LiveStatus>();

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|<>[\]]/g, '\\$&').replace(/\s+/g, ' ');
}

function codeSpan(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
}

function isActive(entry: DelegationStatusEntry): boolean {
  return entry.status === 'queued' || entry.status === 'running';
}

function entryStats(entry: DelegationStatusEntry): string {
  const tokens = formatDelegationTokenCount(entry.tokenCount);
  return [
    `${entry.toolUses} ${pluralize(entry.toolUses, 'tool', 'tools')}`,
    ...(tokens ? [tokens] : []),
  ].join(' · ');
}

function activityLine(entry: DelegationStatusEntry): string | null {
  if (entry.status === 'queued') return '-# ↳ waiting to start';
  if (entry.currentTool) {
    const call = [entry.currentTool, entry.currentToolDetail]
      .filter(Boolean)
      .join(' ');
    return `-# ↳ ${codeSpan(call)}`;
  }
  if (entry.lastTool) return `-# ↳ thinking after ${codeSpan(entry.lastTool)}`;
  return '-# ↳ thinking';
}

export function renderDiscordDelegationStatus(
  snapshot: DelegationStatusSnapshot,
  now: number,
): string {
  const { entries } = snapshot;
  const active = entries.filter(isActive).length;
  const models = distinctDelegateModels(entries, snapshot.parentModel);
  const modelLabel = models.length > 0 ? ` · ${models.join(', ')}` : '';

  if (active === 0) {
    const elapsed = formatDuration((now - snapshot.startedAt) / 1_000);
    const receipt = (entry: DelegationStatusEntry) =>
      `${ENTRY_ICONS[entry.status]} ${escapeMarkdown(entry.title)} · ${entryStats(entry)}`;
    if (entries.length === 1) {
      return `-# ${receipt(entries[0])} · ${elapsed}${modelLabel}`;
    }
    const done = entries.filter((entry) => entry.status === 'completed').length;
    return [
      `-# Delegated ${done}/${entries.length} ${pluralize(entries.length, 'job', 'jobs')} in ${elapsed}${modelLabel}`,
      ...entries.map((entry) => `-# ${receipt(entry)}`),
    ].join('\n');
  }

  const started = `<t:${Math.floor(snapshot.startedAt / 1_000)}:R>`;
  const heading =
    entries.length === 1
      ? `-# Delegating${modelLabel} · started ${started}`
      : `-# Delegating ${entries.length} jobs · ${active} running${modelLabel} · started ${started}`;
  const lines = [heading];
  for (const entry of entries) {
    lines.push(
      `${ENTRY_ICONS[entry.status]} **${escapeMarkdown(entry.title)}** · ${entryStats(entry)}`,
    );
    const activity = isActive(entry) ? activityLine(entry) : null;
    if (activity) lines.push(activity);
  }
  return lines.join('\n');
}

async function sendStatusMessage(
  channelId: string,
  text: string,
): Promise<EditableMessage | undefined> {
  const runtime = await discordRuntimeLoader.load();
  const [message] = await runtime.sendToChannel(channelId, text);
  return message;
}

function flush(status: LiveStatus, jobId: string): Promise<void> {
  status.chain = status.chain.then(async () => {
    const message = await status.message.catch(() => undefined);
    if (!message || status.latest === status.shown) return;
    const text = status.latest;
    status.shown = text;
    status.lastEditAt = Date.now();
    try {
      await withDiscordRetry('edit-delegate-status', () =>
        message.edit({ content: text }),
      );
    } catch (err) {
      logger.warn({ err, jobId }, 'Discord delegate status edit failed');
    }
  });
  return status.chain;
}

/** Posts or edits the live status message for one delegation job. */
export async function publishDiscordDelegationStatus(
  channelId: string,
  snapshot: DelegationStatusSnapshot,
): Promise<void> {
  const text = renderDiscordDelegationStatus(snapshot, Date.now());
  const finished = !snapshot.entries.some(isActive);
  const status = liveStatuses.get(snapshot.jobId);

  if (!status) {
    const message = sendStatusMessage(channelId, text);
    if (!finished) {
      liveStatuses.set(snapshot.jobId, {
        message,
        latest: text,
        shown: text,
        lastEditAt: Date.now(),
        timer: null,
        chain: Promise.resolve(),
      });
    }
    await message;
    return;
  }

  status.latest = text;
  if (finished) {
    liveStatuses.delete(snapshot.jobId);
    if (status.timer) clearTimeout(status.timer);
    status.timer = null;
    await flush(status, snapshot.jobId);
    return;
  }
  if (status.timer) return;
  status.timer = setTimeout(
    () => {
      status.timer = null;
      void flush(status, snapshot.jobId);
    },
    Math.max(0, status.lastEditAt + STATUS_EDIT_INTERVAL_MS - Date.now()),
  );
}
