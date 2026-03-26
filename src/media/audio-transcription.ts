import path from 'node:path';

import {
  ADDITIONAL_MOUNTS,
  CONTAINER_BINDS,
  CONTAINER_SANDBOX_MODE,
  DATA_DIR,
} from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  buildValidatedMountAliases,
  resolveAllowedHostMediaPath,
} from '../security/media-paths.js';
import type { MediaContextItem } from '../types/container.js';
import {
  resolveAudioTranscriptionModels,
  transcribeAudioWithFallback,
} from './audio-transcription-backends.js';
import { MANAGED_TEMP_MEDIA_DIR_PREFIXES } from './managed-temp-media.js';
import { AUDIO_FILE_EXTENSION_RE, normalizeMimeType } from './mime-utils.js';
import {
  resolveUploadedMediaCacheHostDir,
  UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
} from './uploaded-media-cache.js';

const WORKSPACE_ROOT_DISPLAY = '/workspace';
const DISCORD_MEDIA_CACHE_ROOT_DISPLAY = '/discord-media-cache';
const DISCORD_MEDIA_CACHE_ROOT = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);

export interface AudioTranscriptItem {
  filename: string;
  mimeType: string | null;
  path: string;
  text: string;
}

export interface AudioTranscriptionPrelude {
  content: string;
  transcripts: AudioTranscriptItem[];
}

export function isAudioMediaItem(item: MediaContextItem): boolean {
  const mimeType = normalizeMimeType(item.mimeType);
  if (mimeType?.startsWith('audio/')) return true;
  return AUDIO_FILE_EXTENSION_RE.test(item.filename || '');
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1_000, maxChars - 16)).trimEnd()}\n...[truncated]`;
}

function formatTranscriptPrelude(transcripts: AudioTranscriptItem[]): string {
  const lines = ['[AudioTranscript]'];
  for (const [index, transcript] of transcripts.entries()) {
    const mimeSuffix = transcript.mimeType ? ` (${transcript.mimeType})` : '';
    lines.push(`${index + 1}. ${transcript.filename}${mimeSuffix}:`);
    lines.push(transcript.text);
  }
  lines.push('[/AudioTranscript]');
  return lines.join('\n');
}

export async function prependAudioTranscriptionsToUserContent(params: {
  content: string;
  media: MediaContextItem[];
  workspaceRoot: string;
  abortSignal?: AbortSignal;
}): Promise<AudioTranscriptionPrelude> {
  const audioMedia = params.media.filter(
    (item) =>
      isAudioMediaItem(item) && typeof item.path === 'string' && item.path,
  );
  if (audioMedia.length === 0) {
    return {
      content: params.content,
      transcripts: [],
    };
  }

  const audioConfig = getRuntimeConfig().media.audio;
  if (!audioConfig.enabled) {
    logger.debug(
      { audioCount: audioMedia.length },
      'Skipping audio transcription because media.audio is disabled',
    );
    return {
      content: params.content,
      transcripts: [],
    };
  }

  const models = await resolveAudioTranscriptionModels(audioConfig);
  if (models.length === 0) {
    logger.debug(
      { audioCount: audioMedia.length },
      'Skipping audio transcription because no audio backend is available',
    );
    return {
      content: params.content,
      transcripts: [],
    };
  }

  const mountAliases = buildValidatedMountAliases({
    binds: CONTAINER_BINDS,
    additionalMounts: ADDITIONAL_MOUNTS,
  });
  const transcripts: AudioTranscriptItem[] = [];
  let remainingChars = audioConfig.maxTotalChars;

  for (const item of audioMedia.slice(0, audioConfig.maxFiles)) {
    if (params.abortSignal?.aborted) {
      break;
    }

    const resolvedPath = await resolveAllowedHostMediaPath({
      rawPath: item.path || '',
      workspaceRoot: params.workspaceRoot,
      workspaceRootDisplay: WORKSPACE_ROOT_DISPLAY,
      mediaCacheRoot: DISCORD_MEDIA_CACHE_ROOT,
      mediaCacheRootDisplay: DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
      uploadedMediaRoot: resolveUploadedMediaCacheHostDir(),
      uploadedMediaRootDisplay: UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
      mountAliases,
      managedTempDirPrefixes: MANAGED_TEMP_MEDIA_DIR_PREFIXES,
      allowHostAbsolutePaths: CONTAINER_SANDBOX_MODE === 'host',
    });
    if (!resolvedPath) {
      logger.debug(
        {
          mediaPath: item.path,
          filename: item.filename,
        },
        'Skipping audio transcription for media outside allowed roots',
      );
      continue;
    }

    try {
      const transcript = await transcribeAudioWithFallback({
        filePath: resolvedPath,
        fileName: item.filename || path.basename(resolvedPath),
        mimeType: item.mimeType,
        config: audioConfig,
        models,
        abortSignal: params.abortSignal,
      });
      if (!transcript) continue;

      const maxChars = Math.min(
        audioConfig.maxCharsPerTranscript,
        remainingChars,
      );
      if (maxChars <= 0) break;
      const normalized = clampText(transcript.text, maxChars).trim();
      if (!normalized) continue;

      logger.debug(
        {
          backend: transcript.backend,
          filename: item.filename || path.basename(resolvedPath),
          mediaPath: item.path || resolvedPath,
          transcriptChars: normalized.length,
        },
        'Audio transcription completed',
      );

      transcripts.push({
        filename: item.filename || path.basename(resolvedPath),
        mimeType: normalizeMimeType(item.mimeType),
        path: item.path || resolvedPath,
        text: normalized,
      });
      remainingChars = Math.max(0, remainingChars - normalized.length);
    } catch (error) {
      if (params.abortSignal?.aborted) break;
      logger.warn(
        {
          error,
          backends: models.map((entry) =>
            entry.type === 'cli' ? entry.command : entry.provider,
          ),
          filename: item.filename,
          mediaPath: item.path,
        },
        'Audio transcription failed; continuing without transcript',
      );
    }
  }

  if (transcripts.length === 0) {
    return {
      content: params.content,
      transcripts: [],
    };
  }

  const transcriptBlock = formatTranscriptPrelude(transcripts);
  return {
    content: params.content.trim()
      ? `${transcriptBlock}\n\n${params.content}`
      : transcriptBlock,
    transcripts,
  };
}
