import type { TurnContext } from 'botbuilder-core';
import { CardFactory } from 'botbuilder-core';
import {
  type Activity,
  ActivityTypes,
  type Attachment,
} from 'botframework-schema';
import { MSTEAMS_TEXT_CHUNK_LIMIT } from '../../config/config.js';
import type { MSTeamsReplyStyle } from '../../config/runtime-config.js';
import { chunkMessage } from '../../memory/chunk.js';
import { formatError } from '../../utils/text-format.js';
import { sendMSTeamsActivityWithRetry } from './retry.js';

export { formatError };

export interface MSTeamsChunkedActivity {
  text: string;
  attachments?: Attachment[] | undefined;
}

export interface BuildMSTeamsMessageActivityParams {
  id?: string | undefined;
  text: string;
  attachments?: Attachment[] | undefined;
  replyStyle: MSTeamsReplyStyle;
  replyToId?: string | null | undefined;
}

export function buildResponseText(text: string, toolsUsed?: string[]): string {
  let body = text;
  if (toolsUsed && toolsUsed.length > 0) {
    body = `${body}\n*Tools: ${toolsUsed.join(', ')}*`;
  }
  return body;
}

export function buildAdaptiveCardAttachment(
  card: Record<string, unknown>,
): Attachment {
  return CardFactory.adaptiveCard(card);
}

export function prepareChunkedActivities(params: {
  text: string;
  attachments?: Attachment[] | undefined;
}): MSTeamsChunkedActivity[] {
  const chunks = chunkMessage(params.text, {
    maxChars: Math.max(200, Math.min(20_000, MSTEAMS_TEXT_CHUNK_LIMIT)),
    maxLines: 120,
  }).filter((entry) => entry.trim().length > 0);
  if (chunks.length === 0 && params.attachments?.length) {
    return [
      {
        text: '',
        attachments: params.attachments,
      },
    ];
  }
  const safeChunks = chunks.length > 0 ? chunks : ['(no content)'];
  return safeChunks.map((text, index) => ({
    text,
    ...(index === safeChunks.length - 1 && params.attachments?.length
      ? { attachments: params.attachments }
      : {}),
  }));
}

export function buildMSTeamsMessageActivity(
  params: BuildMSTeamsMessageActivityParams,
): Partial<Activity> {
  return {
    type: ActivityTypes.Message,
    ...(params.id ? { id: params.id } : {}),
    ...(params.text ? { text: params.text } : {}),
    ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    ...(params.replyStyle === 'thread' && params.replyToId
      ? { replyToId: params.replyToId }
      : {}),
  };
}

export async function sendChunkedReply(params: {
  turnContext: TurnContext;
  text: string;
  replyStyle: MSTeamsReplyStyle;
  replyToId?: string | null | undefined;
  attachments?: Attachment[] | undefined;
}): Promise<void> {
  const chunks = prepareChunkedActivities({
    text: params.text,
    attachments: params.attachments,
  });
  for (const chunk of chunks) {
    await sendMSTeamsActivityWithRetry(
      params.turnContext,
      buildMSTeamsMessageActivity({
        text: chunk.text,
        attachments: chunk.attachments,
        replyStyle: params.replyStyle,
        replyToId: params.replyToId,
      }),
      'msteams.sendChunkedReply',
    );
  }
}
