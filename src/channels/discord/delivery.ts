import type {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Message as DiscordMessage,
} from 'discord.js';

import { chunkMessage } from '../../memory/chunk.js';
import {
  DISCORD_MAX_LINES_PER_MESSAGE,
  DISCORD_TEXT_CHUNK_LIMIT,
} from '../../config/config.js';
import {
  getHumanDelayMs,
  type HumanDelayConfig,
  sleep,
} from './human-delay.js';
import { type MentionLookup, rewriteUserMentions } from './mentions.js';

export type DiscordRetryFn = <T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T>;

export function buildResponseText(text: string, toolsUsed?: string[]): string {
  let body = text;
  if (toolsUsed && toolsUsed.length > 0) {
    const toolsLine = `\n*Tools: ${toolsUsed.join(', ')}*`;
    body = `${text}${toolsLine}`;
  }
  return body;
}

export function formatInfo(title: string, body: string): string {
  return `**${title}**\n${body}`;
}

export function formatError(title: string, detail: string): string {
  return `**${title}:** ${detail}`;
}

export function prepareChunkedPayloads(
  text: string,
  files?: AttachmentBuilder[],
  mentionLookup?: MentionLookup,
): { content: string; files?: AttachmentBuilder[] }[] {
  const prepared = mentionLookup
    ? rewriteUserMentions(text, mentionLookup)
    : text;
  const chunks = chunkMessage(prepared, {
    maxChars: Math.max(200, Math.min(2_000, DISCORD_TEXT_CHUNK_LIMIT)),
    maxLines: Math.max(4, Math.min(200, DISCORD_MAX_LINES_PER_MESSAGE)),
  });
  const safeChunks = chunks.length > 0 ? chunks : ['(no content)'];
  return safeChunks.map((content, i) => ({
    content,
    ...(i === safeChunks.length - 1 && files && files.length > 0
      ? { files }
      : {}),
  }));
}

export async function sendChunkedReply(params: {
  msg: DiscordMessage;
  text: string;
  withRetry: DiscordRetryFn;
  files?: AttachmentBuilder[];
  mentionLookup?: MentionLookup;
  humanDelay?: HumanDelayConfig;
}): Promise<void> {
  const payloads = prepareChunkedPayloads(
    params.text,
    params.files,
    params.mentionLookup,
  );
  for (let i = 0; i < payloads.length; i += 1) {
    if (i === 0) {
      await params.withRetry('reply', () => params.msg.reply(payloads[i]));
    } else {
      const delayMs = getHumanDelayMs(params.humanDelay);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      await params.withRetry('send', () =>
        (
          params.msg.channel as unknown as {
            send: (next: {
              content: string;
              files?: AttachmentBuilder[];
            }) => Promise<void>;
          }
        ).send(payloads[i]),
      );
    }
  }
}

export async function sendChunkedDirectReply(params: {
  msg: DiscordMessage;
  text: string;
  withRetry: DiscordRetryFn;
  files?: AttachmentBuilder[];
  mentionLookup?: MentionLookup;
  humanDelay?: HumanDelayConfig;
}): Promise<void> {
  const payloads = prepareChunkedPayloads(
    params.text,
    params.files,
    params.mentionLookup,
  );
  const dm = await params.withRetry('dm-open', () =>
    params.msg.author.createDM(),
  );
  for (let i = 0; i < payloads.length; i += 1) {
    if (i > 0) {
      const delayMs = getHumanDelayMs(params.humanDelay);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
    const payload = payloads[i];
    await params.withRetry('dm-send', () => dm.send(payload));
  }
}

export async function sendChunkedInteractionReply(params: {
  interaction: ChatInputCommandInteraction;
  text: string;
  withRetry: DiscordRetryFn;
  files?: AttachmentBuilder[];
}): Promise<void> {
  const payloads = prepareChunkedPayloads(params.text, params.files);
  for (let i = 0; i < payloads.length; i += 1) {
    const payload = { ...payloads[i], ephemeral: true };
    if (i === 0) {
      if (params.interaction.replied || params.interaction.deferred) {
        await params.withRetry('interaction-followup', () =>
          params.interaction.followUp(payload),
        );
      } else {
        await params.withRetry('interaction-reply', () =>
          params.interaction.reply(payload),
        );
      }
      continue;
    }
    await params.withRetry('interaction-followup', () =>
      params.interaction.followUp(payload),
    );
  }
}
