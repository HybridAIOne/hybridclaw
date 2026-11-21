import fs from 'node:fs';
import path from 'node:path';
import {
  isAudioMediaItem,
  isImageMediaItem,
} from '@hybridclaw/shared/media-kind';
import { chatContentText } from '@hybridclaw/shared/message-text';

import { inferArtifactMimeType } from './artifacts.js';
import { isSafeDiscordCdnUrl } from './discord-cdn.js';
import { resolveMediaPath, resolveWorkspacePath } from './runtime-paths.js';
import type {
  ChatContentPart,
  ChatMessage,
  ContainerInput,
  MediaContextItem,
} from './types.js';

const NATIVE_VISION_MAX_IMAGES = 8;
const NATIVE_VISION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const NATIVE_AUDIO_MAX_FILES = 1;
const NATIVE_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

function normalizeAllowedLocalMediaPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  return resolveWorkspacePath(trimmed) || resolveMediaPath(trimmed);
}

function inferImageMimeType(
  filePath: string,
  fallbackMime: string | null | undefined,
): string {
  const normalizedFallback = String(fallbackMime || '')
    .trim()
    .toLowerCase();
  if (normalizedFallback.startsWith('image/')) return normalizedFallback;
  const inferred = inferArtifactMimeType(filePath);
  return inferred.startsWith('image/') ? inferred : 'image/png';
}

function inferAudioMimeType(
  filePath: string,
  fallbackMime: string | null | undefined,
): string {
  const normalizedFallback = String(fallbackMime || '')
    .trim()
    .toLowerCase()
    .split(';')[0]
    ?.trim();
  if (normalizedFallback?.startsWith('audio/')) return normalizedFallback;

  const normalized = String(filePath || '').replace(/\\/g, '/');
  const ext = path.posix.extname(normalized).toLowerCase();
  switch (ext) {
    case '.aac':
      return 'audio/aac';
    case '.aif':
    case '.aiff':
      return 'audio/aiff';
    case '.alac':
      return 'audio/alac';
    case '.flac':
      return 'audio/flac';
    case '.m4a':
    case '.mp4':
      return 'audio/mp4';
    case '.mp3':
    case '.mpeg':
    case '.mpga':
      return 'audio/mpeg';
    case '.oga':
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.webm':
      return 'audio/webm';
    case '.wma':
      return 'audio/x-ms-wma';
    default:
      return 'audio/wav';
  }
}

function modelSupportsNativeVision(model: string): boolean {
  const normalized = model.toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes('gpt-5') ||
    normalized.includes('gpt-4o') ||
    normalized.includes('gpt-4.1') ||
    normalized.includes('o1') ||
    normalized.includes('o3') ||
    normalized.includes('vision') ||
    normalized.includes('multimodal') ||
    normalized.includes('gemini') ||
    normalized.includes('claude-3')
  ) {
    return true;
  }
  return false;
}

function providerSupportsNativeAudio(
  provider: ContainerInput['provider'] | undefined,
): boolean {
  return provider === 'vllm';
}

async function resolveMediaImagePartUrl(
  item: MediaContextItem,
): Promise<string | null> {
  const localPath = item.path
    ? normalizeAllowedLocalMediaPath(item.path)
    : null;
  if (localPath) {
    try {
      const image = await fs.promises.readFile(localPath);
      if (image.length > NATIVE_VISION_MAX_IMAGE_BYTES) {
        console.error(
          `[media] skipping ${localPath}: ${image.length}B exceeds native vision max`,
        );
      } else {
        const mimeType = inferImageMimeType(localPath, item.mimeType);
        const base64 = image.toString('base64');
        return `data:${mimeType};base64,${base64}`;
      }
    } catch (err) {
      console.error(
        `[media] failed to read local media ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const fallbackCandidates = [item.url, item.originalUrl]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const candidate of fallbackCandidates) {
    if (!isSafeDiscordCdnUrl(candidate)) continue;
    return candidate;
  }
  return null;
}

async function resolveMediaAudioPart(
  item: MediaContextItem,
): Promise<Extract<ChatContentPart, { type: 'audio_url' }> | null> {
  const localPath = item.path
    ? normalizeAllowedLocalMediaPath(item.path)
    : null;
  if (localPath) {
    try {
      const audio = await fs.promises.readFile(localPath);
      if (audio.length > NATIVE_AUDIO_MAX_BYTES) {
        console.error(
          `[media] skipping ${localPath}: ${audio.length}B exceeds native audio max`,
        );
      } else {
        const mimeType = inferAudioMimeType(localPath, item.mimeType);
        const base64 = audio.toString('base64');
        return {
          type: 'audio_url',
          audio_url: {
            url: `data:${mimeType};base64,${base64}`,
          },
        };
      }
    } catch (err) {
      console.error(
        `[media] failed to read local audio ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const fallbackCandidates = [item.url, item.originalUrl]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const candidate of fallbackCandidates) {
    if (!isSafeDiscordCdnUrl(candidate)) continue;
    return {
      type: 'audio_url',
      audio_url: {
        url: candidate,
      },
    };
  }
  return null;
}

function findLatestUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

function appendNativePartsToLatestUserMessage(params: {
  messages: ChatMessage[];
  parts: ChatContentPart[];
  hint: string;
  logLabel: string;
}): ChatMessage[] {
  if (params.parts.length === 0) return params.messages;

  const latestUserIndex = findLatestUserIndex(params.messages);
  if (latestUserIndex < 0) return params.messages;

  const cloned = params.messages.map((message) => ({ ...message }));
  const existingContent = cloned[latestUserIndex].content;
  const existingText = chatContentText(existingContent).trim();
  const existingNonTextParts = Array.isArray(existingContent)
    ? existingContent.filter((part) => part.type !== 'text')
    : [];
  const contentParts: ChatContentPart[] = [
    {
      type: 'text',
      text: existingText ? `${existingText}\n\n${params.hint}` : params.hint,
    },
    ...existingNonTextParts,
    ...params.parts,
  ];

  cloned[latestUserIndex] = {
    ...cloned[latestUserIndex],
    content: contentParts,
  };
  console.error(
    `[media] injected ${params.parts.length} native ${params.logLabel} part(s)`,
  );
  return cloned;
}

export async function injectNativeVisionContent(params: {
  messages: ChatMessage[];
  model: string;
  media: MediaContextItem[] | undefined;
}): Promise<ChatMessage[]> {
  if (!Array.isArray(params.media) || params.media.length === 0) {
    return params.messages;
  }
  if (!modelSupportsNativeVision(params.model)) return params.messages;

  const mediaSlice = params.media
    .filter((item) => isImageMediaItem(item))
    .slice(0, NATIVE_VISION_MAX_IMAGES);
  const imageParts: ChatContentPart[] = [];
  for (const item of mediaSlice) {
    const url = await resolveMediaImagePartUrl(item);
    if (!url) continue;
    imageParts.push({ type: 'image_url', image_url: { url } });
  }

  return appendNativePartsToLatestUserMessage({
    messages: params.messages,
    parts: imageParts,
    hint: '[NativeVision] Image parts are attached in this message. Analyze them directly and skip extra vision tool pre-analysis unless explicitly required.',
    logLabel: 'vision image',
  });
}

export async function injectNativeAudioContent(params: {
  messages: ChatMessage[];
  provider: ContainerInput['provider'] | undefined;
  media: MediaContextItem[] | undefined;
  audioTranscriptsPrepended?: boolean;
}): Promise<ChatMessage[]> {
  if (!Array.isArray(params.media) || params.media.length === 0) {
    return params.messages;
  }
  if (!providerSupportsNativeAudio(params.provider)) return params.messages;
  if (params.audioTranscriptsPrepended) return params.messages;

  const audioMedia = params.media
    .filter((item) => isAudioMediaItem(item))
    .slice(0, NATIVE_AUDIO_MAX_FILES);
  const audioParts: ChatContentPart[] = [];
  for (const item of audioMedia) {
    const audioPart = await resolveMediaAudioPart(item);
    if (!audioPart) continue;
    audioParts.push(audioPart);
  }

  return appendNativePartsToLatestUserMessage({
    messages: params.messages,
    parts: audioParts,
    hint: '[NativeAudio] Audio part(s) are attached in this message. If your model supports native audio input, transcribe or analyze them directly before using shell or external transcription tools.',
    logLabel: 'audio',
  });
}

export function shouldRetryWithoutNativeMedia(
  error: string | undefined,
): boolean {
  const normalized = String(error || '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('image_url') ||
    normalized.includes('audio_url') ||
    normalized.includes('input_audio') ||
    normalized.includes('unsupported image') ||
    normalized.includes('unsupported audio') ||
    normalized.includes('unsupported content') ||
    normalized.includes('audio input') ||
    normalized.includes('vision') ||
    normalized.includes('multimodal') ||
    normalized.includes('content part')
  );
}
