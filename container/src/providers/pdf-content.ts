/**
 * PDF replay references become endpoint-specific user content only at dispatch.
 * Tool replies retain their pairing and snapshots survive worker replacement.
 * Unlike vision_analyze this never calls a second model or grants file access.
 */
import {
  loadPdfSnapshot,
  PDF_SNAPSHOT_MAX_BYTES,
  validatePdfAttachments,
} from '../../shared/pdf-attachments.js';
import { WORKSPACE_ROOT } from '../runtime-paths.js';
import type { ChatContentPart, ChatMessage } from '../types.js';
import { type NormalizedCallArgs, ProviderRequestError } from './shared.js';

type PdfMode = 'native' | 'images' | 'text';
let mediaAllowed = false;
export function setPdfMediaAllowed(allowed: boolean): void {
  mediaAllowed = allowed;
}

function modeForEndpoint(args: NormalizedCallArgs): PdfMode {
  if (!mediaAllowed || args.providerMethod === 'claude-cli') return 'text';
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

async function materialize(
  messages: ChatMessage[],
  mode: PdfMode,
): Promise<ChatMessage[]> {
  const result: ChatMessage[] = [];
  let toolMedia: ChatContentPart[] = [];
  let bytes = 0;
  const flush = () => {
    if (toolMedia.length) result.push({ role: 'user', content: toolMedia });
    toolMedia = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    const { pdfAttachments, ...plain } = message;
    if (!pdfAttachments?.length) {
      result.push(plain);
      continue;
    }
    if (message.role !== 'tool' && message.role !== 'user')
      throw new Error('PDF attachments require a user or tool message');
    const parts: ChatContentPart[] = [];
    for (const ref of validatePdfAttachments(pdfAttachments)) {
      const label = `${message.role === 'tool' ? `Read result ${message.tool_call_id}: ` : ''}PDF ${ref.id.slice(0, 12)}, original pages ${ref.pages.join(', ')} (in this order).`;
      let status =
        'Visual content not sent; only extracted text is available. Do not claim visual inspection.';
      if (mode !== 'text') {
        try {
          const snapshot = await loadPdfSnapshot(WORKSPACE_ROOT, ref);
          const size =
            mode === 'native'
              ? snapshot.pdf.length
              : snapshot.images.reduce((sum, image) => sum + image.length, 0);
          if (bytes + size > PDF_SNAPSHOT_MAX_BYTES) {
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
          } else if (snapshot.images.length === ref.pages.length) {
            bytes += size;
            parts.push({ type: 'text', text: label });
            snapshot.images.forEach((image, index) => {
              parts.push(
                { type: 'text', text: `Original page ${ref.pages[index]}` },
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
            'PDF snapshot missing or invalid; re-read the original PDF. Visual content is unavailable.';
        }
      }
      parts.push({ type: 'text', text: `${label} ${status}` });
    }
    if (message.role === 'tool') {
      result.push(plain);
      toolMedia.push(...parts);
    } else
      result.push({
        ...plain,
        content: [...asParts(message.content), ...parts],
      });
  }
  flush();
  return result;
}

function unsupportedMedia(error: unknown): boolean {
  return (
    error instanceof ProviderRequestError &&
    [400, 413, 415, 422].includes(error.status) &&
    /(?:image|vision|document|pdf|file_data|input_file|multimodal)/i.test(
      error.body,
    ) &&
    /(?:unsupported|not support|does not support|not allowed|invalid|too large|exceed)/i.test(
      error.body,
    )
  );
}

/** Retry only explicit media rejection, and never after streaming output starts. */
export async function callWithPdfContent<T extends NormalizedCallArgs>(
  args: T,
  call: (args: T) => Promise<import('../types.js').ChatCompletionResponse>,
  emitted: () => boolean = () => false,
): Promise<import('../types.js').ChatCompletionResponse> {
  if (!args.messages.some((message) => message.pdfAttachments?.length))
    return call(args);
  let mode = modeForEndpoint(args);
  for (;;) {
    try {
      return await call({
        ...args,
        messages: await materialize(args.messages, mode),
      });
    } catch (error) {
      if (mode === 'text' || emitted() || !unsupportedMedia(error)) throw error;
      mode = mode === 'native' ? 'images' : 'text';
    }
  }
}
