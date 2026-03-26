import type {
  AttachmentBuilder,
  BaseMessageOptions,
  ChatInputCommandInteraction,
  Message as DiscordMessage,
} from 'discord.js';
import {
  DISCORD_MAX_LINES_PER_MESSAGE,
  DISCORD_TEXT_CHUNK_LIMIT,
} from '../../config/config.js';
import { chunkMessage } from '../../memory/chunk.js';
import type { MemoryCitation } from '../../types/memory.js';
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

export type DiscordMessageComponents = NonNullable<
  BaseMessageOptions['components']
>;

type ChunkedPayload = {
  content: string;
  files?: AttachmentBuilder[];
  components?: DiscordMessageComponents;
};

export function buildResponseText(
  text: string,
  toolsUsed?: string[],
  memoryCitations?: MemoryCitation[],
): string {
  let body = text;
  if (memoryCitations && memoryCitations.length > 0) {
    const citationLines = memoryCitations.map(
      (citation) =>
        `${citation.ref}: ${citation.content} (${Math.round(citation.confidence * 100)}%)`,
    );
    body += `\n\n*Recalled memories:*\n${citationLines.join('\n')}`;
  }
  if (toolsUsed && toolsUsed.length > 0) {
    const toolsLine = `\n*Tools: ${toolsUsed.join(', ')}*`;
    body += toolsLine;
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
  components?: DiscordMessageComponents,
  mentionLookup?: MentionLookup,
): ChunkedPayload[] {
  const prepared = mentionLookup
    ? rewriteUserMentions(text, mentionLookup)
    : text;
  const chunks = chunkMessage(prepared, {
    maxChars: Math.max(200, Math.min(2_000, DISCORD_TEXT_CHUNK_LIMIT)),
    maxLines: Math.max(4, Math.min(200, DISCORD_MAX_LINES_PER_MESSAGE)),
  }).filter((chunk) => chunk.trim().length > 0);
  const safeChunks = chunks.length > 0 ? chunks : ['(no content)'];
  return safeChunks.map((content, i) => ({
    content,
    ...(i === 0 && components?.length ? { components } : {}),
    ...(i === safeChunks.length - 1 && files?.length ? { files } : {}),
  }));
}

export async function sendChunkedReply(params: {
  msg: DiscordMessage;
  text: string;
  withRetry: DiscordRetryFn;
  files?: AttachmentBuilder[];
  components?: DiscordMessageComponents;
  mentionLookup?: MentionLookup;
  humanDelay?: HumanDelayConfig;
}): Promise<void> {
  const payloads = prepareChunkedPayloads(
    params.text,
    params.files,
    params.components,
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
  components?: DiscordMessageComponents;
  mentionLookup?: MentionLookup;
  humanDelay?: HumanDelayConfig;
}): Promise<void> {
  const payloads = prepareChunkedPayloads(
    params.text,
    params.files,
    params.components,
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
  components?: DiscordMessageComponents;
}): Promise<void> {
  const payloads = prepareChunkedPayloads(
    params.text,
    params.files,
    params.components,
  );
  const isGuildInteraction = Boolean(params.interaction.guildId);
  for (let i = 0; i < payloads.length; i += 1) {
    const payload = isGuildInteraction
      ? { ...payloads[i], flags: 'Ephemeral' as const }
      : payloads[i];
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
