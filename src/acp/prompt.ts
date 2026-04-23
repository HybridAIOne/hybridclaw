import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AvailableCommand, ContentBlock } from '@agentclientprotocol/sdk';
import { buildTuiSlashCommandDefinitions } from '../command-registry.js';
import type { MediaContextItem } from '../types/container.js';

export interface AcpPromptInput {
  content: string;
  media: MediaContextItem[];
}

function deriveFilenameFromUri(uri: string | null | undefined): string | null {
  const trimmed = String(uri || '').trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith('file://')) {
      const filename = path.basename(fileURLToPath(trimmed));
      return filename || null;
    }
  } catch {
    // Fall through to generic path parsing.
  }

  const withoutQuery = trimmed.split('?')[0]?.split('#')[0] || '';
  const filename = path.basename(withoutQuery);
  return filename && filename !== '.' && filename !== '/' ? filename : null;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    default:
      return 'bin';
  }
}

function estimateBase64Size(base64: string): number {
  const sanitized = base64.replace(/\s+/g, '');
  if (!sanitized) return 0;
  const padding = sanitized.endsWith('==')
    ? 2
    : sanitized.endsWith('=')
      ? 1
      : 0;
  return Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
}

function buildInlineMediaItem(params: {
  kind: 'image' | 'audio' | 'resource';
  index: number;
  data: string;
  mimeType: string;
  uri?: string | null;
}): MediaContextItem {
  const dataUrl = `data:${params.mimeType};base64,${params.data}`;
  const filename =
    deriveFilenameFromUri(params.uri) ||
    `${params.kind}-${params.index}.${extensionForMimeType(params.mimeType)}`;

  return {
    path: null,
    url: dataUrl,
    originalUrl: String(params.uri || '').trim() || dataUrl,
    mimeType: params.mimeType,
    sizeBytes: estimateBase64Size(params.data),
    filename,
  };
}

function describeResourceLink(
  block: Extract<ContentBlock, { type: 'resource_link' }>,
): string {
  const parts = [block.name.trim()];
  if (block.uri?.trim()) {
    parts.push(`(${block.uri.trim()})`);
  }
  if (block.description?.trim()) {
    parts.push(`- ${block.description.trim()}`);
  }
  return `[Resource: ${parts.join(' ')}]`;
}

function describeUnsupportedResource(params: {
  mimeType?: string | null;
  uri?: string | null;
}): string {
  const parts = ['[Embedded resource'];
  if (params.mimeType?.trim()) {
    parts.push(` ${params.mimeType.trim()}`);
  }
  if (params.uri?.trim()) {
    parts.push(` ${params.uri.trim()}`);
  }
  parts.push(']');
  return parts.join('');
}

export function buildAcpAvailableCommands(): AvailableCommand[] {
  return buildTuiSlashCommandDefinitions([])
    .filter(
      (definition) => definition.name !== 'paste' && definition.name !== 'exit',
    )
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      input: {
        hint: 'Arguments',
      },
    }));
}

export function convertAcpPromptBlocks(prompt: ContentBlock[]): AcpPromptInput {
  const textParts: string[] = [];
  const media: MediaContextItem[] = [];

  for (const [index, block] of prompt.entries()) {
    switch (block.type) {
      case 'text':
        if (block.text) {
          textParts.push(block.text);
        }
        break;

      case 'resource_link':
        textParts.push(describeResourceLink(block));
        break;

      case 'image':
        media.push(
          buildInlineMediaItem({
            kind: 'image',
            index: media.length + 1,
            data: block.data,
            mimeType: block.mimeType,
            uri: block.uri,
          }),
        );
        break;

      case 'audio':
        textParts.push(
          `[Audio attachment: ${block.mimeType}${block.annotations?.lastModified ? `, ${block.annotations.lastModified}` : ''}]`,
        );
        break;

      case 'resource': {
        const resource = block.resource;
        if ('text' in resource) {
          textParts.push(`[Embedded resource: ${resource.uri}]`);
          textParts.push(resource.text);
          break;
        }
        if (resource.mimeType?.toLowerCase().startsWith('image/')) {
          media.push(
            buildInlineMediaItem({
              kind: 'resource',
              index: media.length + 1,
              data: resource.blob,
              mimeType: resource.mimeType,
              uri: resource.uri,
            }),
          );
          break;
        }
        textParts.push(
          describeUnsupportedResource({
            mimeType: resource.mimeType,
            uri: resource.uri,
          }),
        );
        break;
      }

      default:
        textParts.push(`[Unsupported ACP content block ${index + 1}]`);
        break;
    }
  }

  return {
    content: textParts.join('\n\n').trim(),
    media,
  };
}
