import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ADDITIONAL_MOUNTS,
  CONTAINER_BINDS,
  CONTAINER_SANDBOX_MODE,
  DATA_DIR,
} from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import { resolveConfiguredAdditionalMounts } from '../security/mount-config.js';
import { validateAdditionalMounts } from '../security/mount-security.js';
import type { MediaContextItem } from '../types.js';
import {
  resolveAudioTranscriptionModels,
  transcribeAudioWithFallback,
} from './audio-transcription-backends.js';

const WORKSPACE_ROOT_DISPLAY = '/workspace';
const DISCORD_MEDIA_CACHE_ROOT_DISPLAY = '/discord-media-cache';
const DISCORD_MEDIA_CACHE_ROOT = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);
const AUDIO_FILE_EXTENSION_RE =
  /\.(aac|aif|aiff|alac|flac|m4a|mp3|mp4|mpeg|mpga|oga|ogg|opus|wav|webm|wma)$/i;

interface ValidatedMountAlias {
  hostPath: string;
  containerPath: string;
}

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

function normalizeMimeType(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().split(';')[0]?.trim();
  return normalized || null;
}

export function isAudioMediaItem(item: MediaContextItem): boolean {
  const mimeType = normalizeMimeType(item.mimeType);
  if (mimeType?.startsWith('audio/')) return true;
  return AUDIO_FILE_EXTENSION_RE.test(item.filename || '');
}

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

async function resolveCanonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function buildValidatedMountAliases(): ValidatedMountAlias[] {
  try {
    const configured = resolveConfiguredAdditionalMounts({
      binds: CONTAINER_BINDS,
      additionalMounts: ADDITIONAL_MOUNTS,
    });
    if (configured.mounts.length === 0) return [];

    return validateAdditionalMounts(configured.mounts).map((mount) => ({
      hostPath: mount.hostPath,
      containerPath: normalizePathSlashes(mount.containerPath),
    }));
  } catch (error) {
    logger.warn(
      { error },
      'Falling back to built-in media roots after mount alias validation failed',
    );
    return [];
  }
}

function resolveDisplayPathToHost(
  rawPath: string,
  workspaceRoot: string,
  mountAliases: ValidatedMountAlias[],
): string | null {
  const normalized = normalizePathSlashes(rawPath);

  for (const alias of mountAliases) {
    if (
      normalized === alias.containerPath ||
      normalized.startsWith(`${alias.containerPath}/`)
    ) {
      const relative = normalized
        .slice(alias.containerPath.length)
        .replace(/^\/+/, '');
      return relative
        ? path.resolve(alias.hostPath, relative)
        : path.resolve(alias.hostPath);
    }
  }

  if (
    normalized === WORKSPACE_ROOT_DISPLAY ||
    normalized.startsWith(`${WORKSPACE_ROOT_DISPLAY}/`)
  ) {
    const relative = normalized
      .slice(WORKSPACE_ROOT_DISPLAY.length)
      .replace(/^\/+/, '');
    return relative
      ? path.resolve(workspaceRoot, relative)
      : path.resolve(workspaceRoot);
  }

  if (
    normalized === DISCORD_MEDIA_CACHE_ROOT_DISPLAY ||
    normalized.startsWith(`${DISCORD_MEDIA_CACHE_ROOT_DISPLAY}/`)
  ) {
    const relative = normalized
      .slice(DISCORD_MEDIA_CACHE_ROOT_DISPLAY.length)
      .replace(/^\/+/, '');
    return relative
      ? path.resolve(DISCORD_MEDIA_CACHE_ROOT, relative)
      : path.resolve(DISCORD_MEDIA_CACHE_ROOT);
  }

  return null;
}

async function resolveAllowedHostMediaPath(params: {
  rawPath: string;
  workspaceRoot: string;
  mountAliases: ValidatedMountAlias[];
}): Promise<string | null> {
  const { rawPath, workspaceRoot, mountAliases } = params;
  const cleaned = rawPath.trim();
  if (!cleaned) return null;

  const explicitAbsoluteInput =
    path.isAbsolute(cleaned) ||
    /^[A-Za-z]:[\\/]/.test(cleaned) ||
    cleaned.startsWith('~/') ||
    cleaned.startsWith('~\\');

  const displayResolved = resolveDisplayPathToHost(
    cleaned,
    workspaceRoot,
    mountAliases,
  );
  const expanded = expandUserPath(cleaned);
  const resolved = displayResolved
    ? displayResolved
    : path.isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
      ? path.resolve(expanded)
      : path.resolve(workspaceRoot, expanded);
  const canonical = await resolveCanonicalPath(resolved);
  const allowedRoots = await Promise.all(
    [
      workspaceRoot,
      DISCORD_MEDIA_CACHE_ROOT,
      ...mountAliases.map((alias) => alias.hostPath),
    ].map((entry) => resolveCanonicalPath(entry)),
  );

  if (!allowedRoots.some((root) => isWithinRoot(canonical, root))) {
    if (!(CONTAINER_SANDBOX_MODE === 'host' && explicitAbsoluteInput)) {
      return null;
    }
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(canonical);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return canonical;
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

  const mountAliases = buildValidatedMountAliases();
  const transcripts: AudioTranscriptItem[] = [];
  let remainingChars = audioConfig.maxTotalChars;

  for (const item of audioMedia.slice(0, audioConfig.maxFiles)) {
    if (params.abortSignal?.aborted) {
      break;
    }

    const resolvedPath = await resolveAllowedHostMediaPath({
      rawPath: item.path || '',
      workspaceRoot: params.workspaceRoot,
      mountAliases,
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
