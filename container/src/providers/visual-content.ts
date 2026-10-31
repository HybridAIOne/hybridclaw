/**
 * Visual replay references become endpoint-specific user content only at dispatch.
 * Tool replies retain their pairing and snapshots survive worker replacement.
 * Direct-model capability never grants pixel-delivery permission. Unlike
 * vision_analyze this never calls a second model or grants file access.
 * Text-only handoffs retain every durable reference with shared batch guidance;
 * estimates charge those notices instead of pixels the route cannot send.
 */
import {
  loadVisualSnapshot,
  VISUAL_SNAPSHOT_MAX_BYTES,
  validateVisualAttachments,
} from '../../shared/visual-snapshots.js';
import { WORKSPACE_STATE_ROOT } from '../runtime-paths.js';
import {
  estimateChatMessageTokens,
  estimateMessageTokens,
  type TokenEstimateCache,
} from '../token-usage.js';
import type { ChatContentPart, ChatMessage, ToolDefinition } from '../types.js';
import { type NormalizedCallArgs, ProviderRequestError } from './shared.js';

type PdfMode = 'native' | 'images' | 'text';
let mediaAllowed = false;
let primaryModelSupportsVisualMedia = true;
export function setVisualMediaAllowed(
  allowed: boolean,
  primarySupportsVisualMedia = true,
): void {
  mediaAllowed = allowed;
  primaryModelSupportsVisualMedia = primarySupportsVisualMedia;
}

export function isVisualMediaAllowed(): boolean {
  return mediaAllowed;
}

function textOnly(providerMethod?: string): boolean {
  return (
    !mediaAllowed ||
    !primaryModelSupportsVisualMedia ||
    providerMethod === 'claude-cli'
  );
}

function modeForEndpoint(args: NormalizedCallArgs): PdfMode {
  if (textOnly(args.providerMethod)) return 'text';
  const url = new URL(args.baseUrl);
  if (
    url.protocol === 'https:' &&
    ((args.provider === 'openai' && url.hostname === 'api.openai.com') ||
      (args.provider === 'anthropic' && url.hostname === 'api.anthropic.com'))
  )
    return 'native';
  return 'images';
}

function asParts(content: ChatMessage['content']): ChatContentPart[] {
  return Array.isArray(content)
    ? [...content]
    : [{ type: 'text', text: content || '' }];
}

function textGuidance(auxiliaryVisionAvailable: boolean): ChatContentPart {
  return {
    type: 'text',
    text: !mediaAllowed
      ? 'Visual content not sent: visual-data delivery is disabled by policy. Use extracted text only; do not send these pixels to another model.'
      : `Visual content not sent to this model. ${
          auxiliaryVisionAvailable
            ? 'Use vision_analyze with snapshot=<reference below> and question=<what to inspect>; set page=<one original page> for PDFs, omit page for images.'
            : 'Use extracted text, or discover whether a permitted vision-capable tool supports these read snapshots; otherwise report the limitation.'
        } Do not retry visual input to this same model or search for provider credentials.`,
  };
}

function visualLabel(
  message: ChatMessage,
  ref: NonNullable<ChatMessage['visualAttachments']>[number],
): string {
  return `${message.role === 'tool' ? `Read result ${message.tool_call_id}: ` : ''}${ref.pages.length ? `PDF ${ref.id.slice(0, 12)}, original pages ${ref.pages.join(', ')} (in this order).` : `Image ${ref.id.slice(0, 12)}.`}`;
}

function textReference(
  message: ChatMessage,
  ref: NonNullable<ChatMessage['visualAttachments']>[number],
): ChatContentPart {
  return {
    type: 'text',
    text: `${visualLabel(message, ref)}${mediaAllowed ? ` Snapshot: ${JSON.stringify(ref)}` : ''}`,
  };
}

/** Count only the visual representation this route can actually send. */
export function estimateVisualMessageTokens(
  messages: ChatMessage[],
  routing: { providerMethod?: string; tools?: ToolDefinition[] } = {},
  cache?: TokenEstimateCache,
): number {
  if (!textOnly(routing.providerMethod))
    return estimateMessageTokens(messages, cache);
  const guidance = textGuidance(
    routing.tools?.some((tool) => tool.function.name === 'vision_analyze') ??
      false,
  );
  return messages.reduce((total, message) => {
    if (!message.visualAttachments?.length)
      return total + estimateChatMessageTokens(message, cache);
    const { visualAttachments, ...plain } = message;
    // Conservative: charge a header per message even when a batch shares one.
    return (
      total +
      estimateChatMessageTokens(plain) +
      estimateMessageTokens([
        {
          role: 'user',
          content: [
            guidance,
            ...validateVisualAttachments(visualAttachments).map((ref) =>
              textReference(message, ref),
            ),
          ],
        },
      ])
    );
  }, 0);
}

async function materialize(
  messages: ChatMessage[],
  mode: PdfMode,
  auxiliaryVisionAvailable: boolean,
): Promise<ChatMessage[]> {
  const result: ChatMessage[] = [];
  let toolMedia: ChatContentPart[] = [];
  let bytes = 0;
  const flush = () => {
    if (toolMedia.length)
      result.push({
        role: 'user',
        content:
          mode === 'text'
            ? [textGuidance(auxiliaryVisionAvailable), ...toolMedia]
            : toolMedia,
      });
    toolMedia = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    const { visualAttachments, ...plain } = message;
    if (!visualAttachments?.length) {
      result.push(plain);
      continue;
    }
    if (message.role !== 'tool' && message.role !== 'user')
      throw new Error('Visual attachments require a user or tool message');
    const parts: ChatContentPart[] = [];
    for (const ref of validateVisualAttachments(visualAttachments)) {
      if (mode === 'text') {
        parts.push(textReference(message, ref));
        continue;
      }
      const label = visualLabel(message, ref);
      let status: string;
      try {
        const snapshot = await loadVisualSnapshot(WORKSPACE_STATE_ROOT, ref);
        const size =
          mode === 'native' && snapshot.pdf
            ? snapshot.pdf.length
            : snapshot.images.reduce((sum, image) => sum + image.length, 0);
        if (bytes + size > VISUAL_SNAPSHOT_MAX_BYTES) {
          status =
            'Visual request budget exceeded; read fewer pages. Only extracted text is available.';
        } else if (mode === 'native' && snapshot.pdf) {
          bytes += size;
          parts.push(
            { type: 'text', text: label },
            {
              type: 'file',
              file: {
                filename: `pages-${ref.pages.join('-')}.pdf`,
                file_data: `data:application/pdf;base64,${snapshot.pdf}`,
              },
            },
          );
          continue;
        } else if (snapshot.images.length === (ref.pages.length || 1)) {
          bytes += size;
          parts.push({ type: 'text', text: label });
          snapshot.images.forEach((image, index) => {
            parts.push(
              {
                type: 'text',
                text: ref.pages.length
                  ? `Original page ${ref.pages[index]}`
                  : 'Image content',
              },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${image}` },
              },
            );
          });
          continue;
        } else
          status =
            'Page rendering unavailable; only extracted text is available.';
      } catch {
        status =
          'Visual snapshot missing or invalid; re-read the original file. Visual content is unavailable.';
      }
      parts.push({ type: 'text', text: `${label} ${status}` });
    }
    if (message.role === 'tool') {
      result.push(plain);
      toolMedia.push(...parts);
    } else
      result.push({
        ...plain,
        content: [
          ...asParts(message.content),
          ...(mode === 'text' ? [textGuidance(auxiliaryVisionAvailable)] : []),
          ...parts,
        ],
      });
  }
  flush();
  return result;
}

function unsupportedMedia(error: unknown): boolean {
  if (!(error instanceof ProviderRequestError)) return false;
  // OpenRouter reports missing image-capable routes as 404, not 400.
  if (error.status === 404)
    return /\bno endpoints found that support image input\b/i.test(error.body);
  return (
    [400, 413, 415, 422].includes(error.status) &&
    /(?:image|vision|document|pdf|file_data|input_file|multimodal)/i.test(
      error.body,
    ) &&
    /(?:unsupported|not support|does not support|not allowed|invalid|too large|exceed|at most \d+ image)/i.test(
      error.body,
    )
  );
}

/** Retry only explicit media rejection, and never after streaming output starts. */
export async function callWithVisualContent<T extends NormalizedCallArgs>(
  args: T,
  call: (args: T) => Promise<import('../types.js').ChatCompletionResponse>,
  emitted: () => boolean = () => false,
): Promise<import('../types.js').ChatCompletionResponse> {
  if (!args.messages.some((message) => message.visualAttachments?.length))
    return call(args);
  let mode = modeForEndpoint(args);
  for (;;) {
    try {
      return await call({
        ...args,
        messages: await materialize(
          args.messages,
          mode,
          args.tools.some((tool) => tool.function.name === 'vision_analyze'),
        ),
      });
    } catch (error) {
      if (mode === 'text' || emitted() || !unsupportedMedia(error)) throw error;
      mode = mode === 'native' ? 'images' : 'text';
    }
  }
}
