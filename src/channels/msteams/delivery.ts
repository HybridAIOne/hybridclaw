import type { TurnContext } from 'botbuilder-core';
import { CardFactory } from 'botbuilder-core';
import {
  type Activity,
  ActivityTypes,
  type Attachment,
  TextFormatTypes,
} from 'botframework-schema';
import { MSTEAMS_TEXT_CHUNK_LIMIT } from '../../config/config.js';
import type { MSTeamsReplyStyle } from '../../config/runtime-config.js';
import { chunkMessage } from '../../memory/chunk.js';
import { formatMemoryAccessMarkdown } from '../../memory/recall-presentation.js';
import type { MemoryAccess } from '../../types/memory.js';
import { formatError } from '../../utils/text-format.js';
import { sendMSTeamsActivityWithRetry } from './retry.js';

export { formatError };

export interface MSTeamsChunkedActivity {
  text: string;
  attachments?: Attachment[];
}

export interface BuildMSTeamsMessageActivityParams {
  id?: string;
  text: string;
  attachments?: Attachment[];
  replyStyle: MSTeamsReplyStyle;
  replyToId?: string | null;
}

export interface BuildMSTeamsResponseTextOptions {
  /** `msteams.showMemoryFooter`; `false` drops the memory transparency footer. */
  showMemoryFooter?: boolean;
}

export function buildResponseText(
  text: string,
  toolsUsed?: string[],
  memoryAccess?: MemoryAccess,
  options: BuildMSTeamsResponseTextOptions = {},
): string {
  let body = text;
  if (memoryAccess && options.showMemoryFooter !== false) {
    body += `${body ? '\n\n' : ''}${formatMemoryAccessMarkdown(memoryAccess)}`;
  }
  if (toolsUsed && toolsUsed.length > 0) {
    body = `${body}${body ? '\n' : ''}*Tools: ${toolsUsed.join(', ')}*`;
  }
  return body;
}

export function stripUnusableMSTeamsArtifactLinks(text: string): string {
  return text.replace(
    /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    (link, label: string, rawTarget: string) => {
      const target = rawTarget.trim().replace(/^<|>$/g, '');
      const isLocalTarget =
        /^(?:file|sandbox):/i.test(target) ||
        /^\/?api\/artifact\?/i.test(target) ||
        /^(?:\/workspace\/|\.\/)/i.test(target) ||
        (!/^[a-z][a-z0-9+.-]*:/i.test(target) &&
          /\.(?:docx|gif|jpe?g|m4a|m4v|mov|mp3|mp4|ogg|pdf|png|pptx|svg|wav|webm|webp|xlsx)(?:[?#].*)?$/i.test(
            target,
          ));
      return isLocalTarget ? label : link;
    },
  );
}

export function buildAdaptiveCardAttachment(
  card: Record<string, unknown>,
): Attachment {
  return CardFactory.adaptiveCard(card);
}

export interface MSTeamsSessionSwitcherEntry {
  sessionId: string;
  label: string;
  isCurrent: boolean;
}

const SESSION_SWITCHER_MAX_ACTIONS = 5;
const SESSION_SWITCHER_TITLE_LIMIT = 60;

function truncateCardTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length <= SESSION_SWITCHER_TITLE_LIMIT) return normalized;
  return `${normalized.slice(0, SESSION_SWITCHER_TITLE_LIMIT - 1)}…`;
}

function buildMessageBackAction(params: {
  title: string;
  commandText: string;
}): Record<string, unknown> {
  return {
    type: 'Action.Submit',
    title: truncateCardTitle(params.title),
    data: {
      msteams: {
        type: 'messageBack',
        text: params.commandText,
        displayText: params.commandText,
      },
    },
  };
}

export function buildMSTeamsSessionSwitcherCard(
  entries: MSTeamsSessionSwitcherEntry[],
): Attachment {
  const actions = entries
    .filter((entry) => !entry.isCurrent)
    .slice(0, SESSION_SWITCHER_MAX_ACTIONS)
    .map((entry) =>
      buildMessageBackAction({
        title: entry.label,
        commandText: `/sessions switch ${entry.sessionId}`,
      }),
    );
  actions.push(
    buildMessageBackAction({
      title: 'Start a new session',
      commandText: '/new',
    }),
  );

  return buildAdaptiveCardAttachment({
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'Switch session',
        weight: 'Bolder',
        wrap: true,
      },
    ],
    actions,
  });
}

export function formatMSTeamsMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let inCodeFence = false;

  return lines
    .map((line, index) => {
      if (line.trim().startsWith('```')) {
        inCodeFence = !inCodeFence;
        return line;
      }

      const nextLine = lines[index + 1];
      if (
        inCodeFence ||
        !line.trim() ||
        !nextLine?.trim() ||
        line.endsWith('  ')
      ) {
        return line;
      }
      return `${line}  `;
    })
    .join('\n');
}

export function prepareChunkedActivities(params: {
  text: string;
  attachments?: Attachment[];
}): MSTeamsChunkedActivity[] {
  const chunks = chunkMessage(formatMSTeamsMarkdown(params.text), {
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
    ...(params.text
      ? { text: params.text, textFormat: TextFormatTypes.Markdown }
      : {}),
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
  replyToId?: string | null;
  attachments?: Attachment[];
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
