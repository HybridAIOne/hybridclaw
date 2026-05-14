import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { estimateAudioTranscriptionCostUsd } from '../shared/audio-transcription-pricing.js';
import {
  classifyProviderError,
  shouldFallbackProviderError,
} from '../shared/provider-fallback.js';
import { isSafeDiscordCdnUrl } from './discord-cdn.js';
import type { RuntimeProvider } from './providers/provider-ids.js';
import {
  isRecord,
  ProviderRequestError,
  readStringValue,
} from './providers/shared.js';
import {
  DISCORD_MEDIA_CACHE_ROOT,
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  resolveMediaPath,
  resolveWorkspacePath,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';
import type { MediaContextItem, ProviderCredentials } from './types.js';

type AudioTranscriptionProviderId = 'openai' | 'deepgram' | 'assemblyai';
type TimestampMode = 'segment' | 'word' | 'none';

export interface AudioTranscriptionRuntimeContext {
  provider: RuntimeProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  requestHeaders?: Record<string, string>;
  media: MediaContextItem[];
  providerCredentials?: ProviderCredentials;
}

interface ProviderCandidate {
  id: AudioTranscriptionProviderId;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  requestHeaders?: Record<string, string>;
  maxAudioBytes: number;
  supportsDiarization: boolean;
  supportsWordTimestamps: boolean;
  supportsLanguageDetection: boolean;
}

interface AudioInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  source: string;
  localPath?: string;
  cleanupPath?: string;
}

interface NormalizedAudioTranscriptionRequest {
  audio: AudioInput;
  language: string | null;
  prompt: string | null;
  timestamps: TimestampMode;
  provider: string | null;
  diarization: boolean;
  minSpeakers: number | null;
  maxSpeakers: number | null;
  detectLanguageOnly: boolean;
  warnings: string[];
}

interface TranscriptSegment {
  start: number | null;
  end: number | null;
  text: string;
  speaker?: string;
}

interface TranscriptWord {
  start: number | null;
  end: number | null;
  word: string;
  speaker?: string;
}

interface AudioTranscriptionResult {
  text: string;
  language: string | null;
  durationSec: number | null;
  segments: TranscriptSegment[];
  words?: TranscriptWord[];
}

interface CandidateTranscriptionResult {
  result: AudioTranscriptionResult;
  warnings: string[];
}

const OUTPUT_DIR = '.transcripts';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const PROVIDER_API_TIMEOUT_MS = 10 * 60_000;
const ASSEMBLYAI_INITIAL_POLL_INTERVAL_MS = 1_000;
const ASSEMBLYAI_MAX_POLL_INTERVAL_MS = 10_000;
const ASSEMBLYAI_POLL_REQUEST_TIMEOUT_MS = 15_000;
const ASSEMBLYAI_POLL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_DEEPGRAM_BASE_URL = 'https://api.deepgram.com/v1';
const DEFAULT_ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com';
const DEFAULT_OPENAI_AUDIO_MODEL = 'whisper-1';
const DEFAULT_DEEPGRAM_AUDIO_MODEL = 'nova-3';
const DEFAULT_ASSEMBLYAI_AUDIO_MODEL = 'universal';
const DEFAULT_CHUNK_WINDOW_SEC = 25 * 60;
const DEFAULT_CHUNK_OVERLAP_SEC = 10;

function readNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function readBooleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = readNumberValue(value);
  if (parsed == null || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeBaseUrl(value: string, fallback: string): string {
  const trimmed = String(value || '').trim() || fallback;
  return trimmed.replace(/\/+$/g, '');
}

function stripProviderPrefix(model: string, provider: string): string {
  const trimmed = String(model || '').trim();
  const prefix = `${provider}/`;
  if (trimmed.toLowerCase().startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function hasAudioTranscriptionModelHint(model: string): boolean {
  return /whisper|transcribe|transcription/i.test(model);
}

function readCredentialValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSpeechToTextProvider(
  value: unknown,
): AudioTranscriptionProviderId | null {
  const normalized = readCredentialValue(value).toLowerCase();
  if (normalized === 'whisper' || normalized === 'openai-whisper') {
    return 'openai';
  }
  return normalized === 'openai' ||
    normalized === 'deepgram' ||
    normalized === 'assemblyai'
    ? normalized
    : null;
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('mpeg') || normalized === 'audio/mp3') return '.mp3';
  if (normalized.includes('mp4') || normalized.includes('m4a')) return '.m4a';
  if (normalized.includes('ogg')) return '.ogg';
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('wav')) return '.wav';
  if (normalized.includes('flac')) return '.flac';
  return '.audio';
}

function inferAudioMimeType(
  filePath: string,
  fallback?: string | null,
): string {
  const normalizedFallback = String(fallback || '')
    .trim()
    .toLowerCase();
  if (
    normalizedFallback.startsWith('audio/') ||
    normalizedFallback === 'video/mp4' ||
    normalizedFallback === 'video/webm'
  ) {
    return normalizedFallback;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3' || ext === '.mpga' || ext === '.mpeg') {
    return 'audio/mpeg';
  }
  if (ext === '.mp4' || ext === '.m4a') return 'audio/mp4';
  if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return 'audio/ogg';
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.flac') return 'audio/flac';
  return 'application/octet-stream';
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function decodeIpv4MappedIpv6Tail(value: string): string | null {
  if (net.isIP(value) === 4) return value;

  const parts = value.split(':');
  if (parts.length !== 2) return null;

  const words = parts.map((part) => Number.parseInt(part, 16));
  if (
    words.length !== 2 ||
    words.some((part) => Number.isNaN(part) || part < 0 || part > 0xffff)
  ) {
    return null;
  }
  return [
    (words[0] >> 8) & 0xff,
    words[0] & 0xff,
    (words[1] >> 8) & 0xff,
    words[1] & 0xff,
  ].join('.');
}

function isUnsafeIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (net.isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (net.isIP(normalized) === 6) {
    if (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    ) {
      return true;
    }
    const mapped = decodeIpv4MappedIpv6Tail(normalized);
    if (mapped) return isPrivateIpv4(mapped);
  }
  return false;
}

async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('audio URL is invalid');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('audio URL must use https');
  }
  if (isSafeDiscordCdnUrl(rawUrl)) return parsed;

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || hostname === 'localhost' || isUnsafeIpAddress(hostname)) {
    throw new Error('audio URL host is not allowed');
  }

  const records = await lookup(hostname, { all: true, verbatim: false });
  if (records.some((record) => isUnsafeIpAddress(record.address))) {
    throw new Error('audio URL resolves to a private network address');
  }
  // DNS is still resolved separately from fetch; redirect blocking below closes
  // the common SSRF redirect path, while DNS rebinding needs network isolation.
  return parsed;
}

function assertAudioSize(buffer: Buffer, maxBytes = MAX_AUDIO_BYTES): void {
  if (buffer.length <= 0) throw new Error('audio input is empty');
  if (buffer.length > maxBytes) {
    throw new Error(
      `audio input exceeds max provider upload size (${maxBytes} bytes)`,
    );
  }
}

function findMediaContextItem(
  value: string,
  media: MediaContextItem[],
): MediaContextItem | null {
  const normalized = value.trim();
  if (!normalized) return null;
  return (
    media.find(
      (item) =>
        item.path === normalized ||
        item.url === normalized ||
        item.originalUrl === normalized ||
        item.filename === normalized,
    ) || null
  );
}

function resolveImplicitMediaItem(
  media: MediaContextItem[],
): MediaContextItem | null {
  const audioItems = media.filter((item) => {
    const mimeType = String(item.mimeType || '').toLowerCase();
    return (
      mimeType.startsWith('audio/') ||
      mimeType === 'video/mp4' ||
      mimeType === 'video/webm'
    );
  });
  return audioItems.length === 1 ? audioItems[0] : null;
}

async function readLocalAudio(
  rawPath: string,
  mediaHint?: MediaContextItem | null,
): Promise<AudioInput> {
  const resolved =
    resolveWorkspacePath(rawPath) ||
    resolveMediaPath(rawPath) ||
    (mediaHint?.path
      ? resolveWorkspacePath(mediaHint.path) || resolveMediaPath(mediaHint.path)
      : null);
  if (!resolved) {
    throw new Error(
      `audio path must be under ${WORKSPACE_ROOT_DISPLAY}, ${DISCORD_MEDIA_CACHE_ROOT_DISPLAY}, or /uploaded-media-cache`,
    );
  }
  const stat = fs.statSync(resolved);
  if (stat.size <= 0) throw new Error('audio input is empty');
  if (stat.size > 512 * 1024 * 1024) {
    throw new Error(
      'audio input exceeds max provider upload size (536870912 bytes)',
    );
  }
  const buffer = await fs.promises.readFile(resolved);
  assertAudioSize(buffer, 512 * 1024 * 1024);
  const mimeType = inferAudioMimeType(resolved, mediaHint?.mimeType);
  if (
    !mimeType.startsWith('audio/') &&
    mimeType !== 'video/mp4' &&
    mimeType !== 'video/webm'
  ) {
    throw new Error(`unsupported local audio type: ${mimeType}`);
  }
  return {
    buffer,
    filename: path.basename(resolved),
    mimeType,
    localPath: resolved,
    source: resolved.startsWith(WORKSPACE_ROOT)
      ? `${WORKSPACE_ROOT_DISPLAY}/${path.relative(WORKSPACE_ROOT, resolved).replace(/\\/g, '/')}`
      : resolved.startsWith(DISCORD_MEDIA_CACHE_ROOT)
        ? `${DISCORD_MEDIA_CACHE_ROOT_DISPLAY}/${path.relative(DISCORD_MEDIA_CACHE_ROOT, resolved).replace(/\\/g, '/')}`
        : rawPath,
  };
}

async function fetchRemoteAudio(
  rawUrl: string,
  mediaHint?: MediaContextItem | null,
): Promise<AudioInput> {
  const parsed = await assertSafeRemoteUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(rawUrl, {
      signal: controller.signal,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('audio URL redirects are not allowed');
    }
    if (!response.ok) {
      throw new Error(`audio fetch failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 512 * 1024 * 1024) {
      throw new Error(
        'remote audio input exceeds max fetch size (536870912 bytes)',
      );
    }
    const mimeType = inferAudioMimeType(
      parsed.pathname,
      response.headers.get('content-type') || mediaHint?.mimeType,
    );
    if (
      !mimeType.startsWith('audio/') &&
      mimeType !== 'video/mp4' &&
      mimeType !== 'video/webm'
    ) {
      throw new Error(`remote URL is not audio (${mimeType || 'unknown'})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    assertAudioSize(buffer, 512 * 1024 * 1024);
    const filename =
      mediaHint?.filename ||
      path.basename(parsed.pathname) ||
      `audio${extensionFromMimeType(mimeType)}`;
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-stt-src-'),
    );
    const tempPath = path.join(tempDir, filename);
    fs.writeFileSync(tempPath, buffer);
    return {
      buffer,
      filename,
      mimeType,
      localPath: tempPath,
      cleanupPath: tempDir,
      source: rawUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveAudioInput(
  args: Record<string, unknown>,
  context: AudioTranscriptionRuntimeContext,
): Promise<AudioInput> {
  const explicit =
    readStringValue(args.audio) ||
    readStringValue(args.audio_url) ||
    readStringValue(args.path);
  const mediaHint = explicit
    ? findMediaContextItem(explicit, context.media)
    : resolveImplicitMediaItem(context.media);
  const raw = explicit || mediaHint?.path || mediaHint?.url || '';
  if (!raw) {
    throw new Error(
      'audio_transcribe requires an audio path, URL, or exactly one current audio attachment.',
    );
  }

  if (/^https:\/\//i.test(raw)) return fetchRemoteAudio(raw, mediaHint);
  return readLocalAudio(raw, mediaHint);
}

function normalizeTimestampMode(
  value: unknown,
  warnings: string[],
): TimestampMode {
  const raw = readStringValue(value)?.toLowerCase();
  if (!raw || raw === 'segment' || raw === 'segments') return 'segment';
  if (raw === 'word' || raw === 'words') return 'word';
  if (raw === 'none' || raw === 'false' || raw === 'off') return 'none';
  warnings.push(`timestamps "${raw}" is unsupported; using segment.`);
  return 'segment';
}

async function normalizeRequest(
  args: Record<string, unknown>,
  context: AudioTranscriptionRuntimeContext,
): Promise<NormalizedAudioTranscriptionRequest> {
  const warnings: string[] = [];
  const diarization =
    readBooleanValue(args.diarization ?? args.diarize ?? args.speaker_labels) ??
    false;
  const minSpeakers = readPositiveInteger(
    args.min_speakers ?? args.minSpeakers,
  );
  const maxSpeakers = readPositiveInteger(
    args.max_speakers ?? args.maxSpeakers,
  );
  if (minSpeakers && maxSpeakers && minSpeakers !== maxSpeakers) {
    throw new Error(
      'min_speakers and max_speakers must match; provide a single speaker count for AssemblyAI.',
    );
  }
  const action = readStringValue(args.action)?.toLowerCase();
  return {
    audio: await resolveAudioInput(args, context),
    language: readStringValue(args.language),
    prompt: readStringValue(args.prompt),
    timestamps: normalizeTimestampMode(
      args.timestamps ?? args.timestamp_granularities,
      warnings,
    ),
    provider: readStringValue(args.provider),
    diarization,
    minSpeakers,
    maxSpeakers,
    detectLanguageOnly: action === 'detect-language',
    warnings,
  };
}

function candidateFromCurrentContext(
  context: AudioTranscriptionRuntimeContext,
): ProviderCandidate | null {
  if (!context.apiKey || context.provider !== 'openai-codex') return null;
  const model = stripProviderPrefix(context.model, 'openai-codex');
  return {
    id: 'openai',
    label: 'OpenAI / Codex',
    apiKey: context.apiKey,
    baseUrl: normalizeBaseUrl(context.baseUrl, DEFAULT_OPENAI_BASE_URL),
    model: hasAudioTranscriptionModelHint(model)
      ? model
      : DEFAULT_OPENAI_AUDIO_MODEL,
    requestHeaders: context.requestHeaders,
    maxAudioBytes: MAX_AUDIO_BYTES,
    supportsDiarization: false,
    supportsWordTimestamps: true,
    supportsLanguageDetection: true,
  };
}

function buildProviderCandidates(
  context: AudioTranscriptionRuntimeContext,
  providerOverride?: string | null,
): ProviderCandidate[] {
  const candidates: ProviderCandidate[] = [];
  const openaiConfig = context.providerCredentials?.openai || {};
  const openaiKey = readCredentialValue(openaiConfig.apiKey);
  const current = candidateFromCurrentContext(context);
  if (current) candidates.push(current);
  if (openaiKey && !candidates.some((entry) => entry.id === 'openai')) {
    candidates.push({
      id: 'openai',
      label: 'OpenAI',
      apiKey: openaiKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(openaiConfig.baseUrl),
        DEFAULT_OPENAI_BASE_URL,
      ),
      model:
        readCredentialValue(openaiConfig.audioModel) ||
        DEFAULT_OPENAI_AUDIO_MODEL,
      maxAudioBytes: MAX_AUDIO_BYTES,
      supportsDiarization: false,
      supportsWordTimestamps: true,
      supportsLanguageDetection: true,
    });
  }

  const deepgramConfig = context.providerCredentials?.deepgram || {};
  const deepgramKey = readCredentialValue(deepgramConfig.apiKey);
  if (deepgramKey) {
    candidates.push({
      id: 'deepgram',
      label: 'Deepgram',
      apiKey: deepgramKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(deepgramConfig.baseUrl),
        DEFAULT_DEEPGRAM_BASE_URL,
      ),
      model:
        readCredentialValue(deepgramConfig.audioModel) ||
        DEFAULT_DEEPGRAM_AUDIO_MODEL,
      maxAudioBytes: 512 * 1024 * 1024,
      supportsDiarization: true,
      supportsWordTimestamps: true,
      supportsLanguageDetection: true,
    });
  }

  const assemblyaiConfig = context.providerCredentials?.assemblyai || {};
  const assemblyaiKey = readCredentialValue(assemblyaiConfig.apiKey);
  if (assemblyaiKey) {
    candidates.push({
      id: 'assemblyai',
      label: 'AssemblyAI',
      apiKey: assemblyaiKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(assemblyaiConfig.baseUrl),
        DEFAULT_ASSEMBLYAI_BASE_URL,
      ),
      model:
        readCredentialValue(assemblyaiConfig.audioModel) ||
        DEFAULT_ASSEMBLYAI_AUDIO_MODEL,
      maxAudioBytes: 512 * 1024 * 1024,
      supportsDiarization: true,
      supportsWordTimestamps: true,
      supportsLanguageDetection: true,
    });
  }

  const requested = String(providerOverride || 'auto')
    .trim()
    .toLowerCase();
  if (!requested || requested === 'auto' || requested === 'default') {
    const defaultProvider = normalizeSpeechToTextProvider(
      context.providerCredentials?.speechToText?.defaultProvider,
    );
    if (defaultProvider) {
      return [
        ...candidates.filter((candidate) => candidate.id === defaultProvider),
        ...candidates.filter((candidate) => candidate.id !== defaultProvider),
      ];
    }
    return candidates;
  }
  const normalized =
    requested === 'whisper' || requested === 'openai-whisper'
      ? 'openai'
      : requested;
  return candidates.filter((candidate) => candidate.id === normalized);
}

export function listAudioTranscriptionProviders(
  context: AudioTranscriptionRuntimeContext,
): Record<string, unknown> {
  const candidates = buildProviderCandidates(context);
  const ready = new Set(candidates.map((entry) => entry.id));
  const active = candidateFromCurrentContext(context)?.id || null;
  const candidateById = new Map(candidates.map((entry) => [entry.id, entry]));
  return {
    success: true,
    configured_count: candidates.length,
    default_provider: candidates[0]?.id || null,
    providers: [
      {
        id: 'openai',
        label: 'OpenAI Whisper',
        ready: ready.has('openai'),
        active: active === 'openai',
        model:
          candidates.find((entry) => entry.id === 'openai')?.model ||
          DEFAULT_OPENAI_AUDIO_MODEL,
        missing: ready.has('openai')
          ? null
          : 'Store OPENAI_API_KEY with `/secret set OPENAI_API_KEY <key>`, or use an openai-codex model with credentials.',
        capabilities: {
          language_detection: true,
          segment_timestamps: true,
          word_timestamps: true,
          diarization: false,
        },
      },
      {
        id: 'deepgram',
        label: 'Deepgram',
        ready: ready.has('deepgram'),
        active: false,
        model:
          candidateById.get('deepgram')?.model || DEFAULT_DEEPGRAM_AUDIO_MODEL,
        missing: ready.has('deepgram')
          ? null
          : 'Store DEEPGRAM_API_KEY with `/secret set DEEPGRAM_API_KEY <key>`.',
        capabilities: {
          language_detection: true,
          segment_timestamps: true,
          word_timestamps: true,
          diarization: true,
        },
      },
      {
        id: 'assemblyai',
        label: 'AssemblyAI',
        ready: ready.has('assemblyai'),
        active: false,
        model:
          candidateById.get('assemblyai')?.model ||
          DEFAULT_ASSEMBLYAI_AUDIO_MODEL,
        missing: ready.has('assemblyai')
          ? null
          : 'Store ASSEMBLYAI_API_KEY with `/secret set ASSEMBLYAI_API_KEY <key>`.',
        capabilities: {
          language_detection: true,
          segment_timestamps: true,
          word_timestamps: true,
          diarization: true,
        },
      },
    ],
  };
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!key || key.toLowerCase() === 'authorization') continue;
    normalized[key] = value;
  }
  return normalized;
}

function bufferAsBodyInit(buffer: Buffer): BodyInit {
  return buffer as unknown as BodyInit;
}

function bufferAsBlobPart(buffer: Buffer): BlobPart {
  return buffer as unknown as BlobPart;
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = PROVIDER_API_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseProviderJson(
  response: Response,
  providerLabel: string,
): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) {
        const error = parsed.error;
        if (isRecord(error) && typeof error.message === 'string') {
          detail = error.message;
        } else if (typeof error === 'string') {
          detail = error;
        } else if (typeof parsed.message === 'string') {
          detail = parsed.message;
        }
      }
    } catch {
      // Keep the provider text body.
    }
    throw new ProviderRequestError(
      response.status,
      detail || response.statusText,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${providerLabel} transcription returned invalid JSON`);
  }
}

function normalizeSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): TranscriptSegment | null => {
      if (!isRecord(entry)) return null;
      const text = readStringValue(entry.text) || '';
      if (!text) return null;
      const speaker = readStringValue(entry.speaker);
      return {
        start: readNumberValue(entry.start),
        end: readNumberValue(entry.end),
        text,
        ...(speaker ? { speaker } : {}),
      };
    })
    .filter((entry): entry is TranscriptSegment => Boolean(entry));
}

function buildFallbackSegments(
  text: string | null,
  durationSec: number | null,
): TranscriptSegment[] {
  return text ? [{ start: null, end: durationSec, text }] : [];
}

function normalizeWords(value: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const words = value
    .map((entry): TranscriptWord | null => {
      if (!isRecord(entry)) return null;
      const word = readStringValue(entry.word) || readStringValue(entry.text);
      if (!word) return null;
      const speaker = readStringValue(entry.speaker);
      return {
        start: readNumberValue(entry.start),
        end: readNumberValue(entry.end),
        word,
        ...(speaker ? { speaker } : {}),
      };
    })
    .filter((entry): entry is TranscriptWord => Boolean(entry));
  return words.length > 0 ? words : undefined;
}

function formatSpeaker(value: unknown): string | undefined {
  const text = readStringValue(value);
  if (text) return text.startsWith('speaker') ? text : `speaker_${text}`;
  const number = readNumberValue(value);
  return number == null ? undefined : `speaker_${Math.floor(number)}`;
}

async function transcribeWithOpenAi(
  candidate: ProviderCandidate,
  request: NormalizedAudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const form = new FormData();
  form.set('model', candidate.model);
  form.set('response_format', 'verbose_json');
  form.set(
    'file',
    new Blob([bufferAsBlobPart(request.audio.buffer)], {
      type: request.audio.mimeType,
    }),
    request.audio.filename,
  );
  if (request.language) form.set('language', request.language);
  if (request.prompt) form.set('prompt', request.prompt);
  if (request.timestamps !== 'none') {
    form.append(
      'timestamp_granularities[]',
      request.timestamps === 'word' ? 'word' : 'segment',
    );
  }

  const response = await fetchWithTimeout(
    `${candidate.baseUrl}/audio/transcriptions`,
    {
      method: 'POST',
      headers: {
        ...normalizeHeaders(candidate.requestHeaders),
        Authorization: `Bearer ${candidate.apiKey}`,
      },
      body: form,
    },
  );
  const parsed = await parseProviderJson(response, 'OpenAI');
  if (!isRecord(parsed)) {
    throw new Error('OpenAI transcription returned an unexpected payload');
  }
  return {
    text: readStringValue(parsed.text) || '',
    language: readStringValue(parsed.language),
    durationSec: readNumberValue(parsed.duration),
    segments: normalizeSegments(parsed.segments),
    words: normalizeWords(parsed.words),
  };
}

function normalizeDeepgramResult(parsed: Record<string, unknown>) {
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const results = isRecord(parsed.results) ? parsed.results : {};
  const channels = Array.isArray(results.channels) ? results.channels : [];
  const firstChannel = isRecord(channels[0]) ? channels[0] : {};
  const alternatives = Array.isArray(firstChannel.alternatives)
    ? firstChannel.alternatives
    : [];
  const alternative = isRecord(alternatives[0]) ? alternatives[0] : {};
  const utterances = Array.isArray(results.utterances)
    ? results.utterances
    : [];
  const words = normalizeWords(
    Array.isArray(alternative.words)
      ? alternative.words.map((word) =>
          isRecord(word)
            ? {
                ...word,
                speaker: formatSpeaker(word.speaker),
                word: readStringValue(word.punctuated_word) || word.word,
              }
            : word,
        )
      : undefined,
  );
  const segments =
    utterances.length > 0
      ? utterances
          .map((entry): TranscriptSegment | null => {
            if (!isRecord(entry)) return null;
            const text = readStringValue(entry.transcript) || '';
            if (!text) return null;
            const speaker = formatSpeaker(entry.speaker);
            return {
              start: readNumberValue(entry.start),
              end: readNumberValue(entry.end),
              text,
              ...(speaker ? { speaker } : {}),
            };
          })
          .filter((entry): entry is TranscriptSegment => Boolean(entry))
      : normalizeSegments(
          isRecord(alternative.paragraphs)
            ? alternative.paragraphs.paragraphs
            : undefined,
        );
  return {
    text:
      readStringValue(alternative.transcript) ||
      segments.map((segment) => segment.text).join(' '),
    language:
      readStringValue(firstChannel.detected_language) ||
      readStringValue(results.detected_language),
    durationSec: readNumberValue(metadata.duration),
    segments:
      segments.length > 0
        ? segments
        : buildFallbackSegments(
            readStringValue(alternative.transcript),
            readNumberValue(metadata.duration),
          ),
    words,
  };
}

async function transcribeWithDeepgram(
  candidate: ProviderCandidate,
  request: NormalizedAudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const url = new URL(`${candidate.baseUrl}/listen`);
  url.searchParams.set('model', candidate.model);
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('detect_language', request.language ? 'false' : 'true');
  url.searchParams.set('utterances', 'true');
  if (request.language) url.searchParams.set('language', request.language);
  if (request.diarization) url.searchParams.set('diarize', 'true');

  const response = await fetchWithTimeout(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Token ${candidate.apiKey}`,
      'Content-Type': request.audio.mimeType,
    },
    body: bufferAsBodyInit(request.audio.buffer),
  });
  const parsed = await parseProviderJson(response, 'Deepgram');
  if (!isRecord(parsed)) {
    throw new Error('Deepgram transcription returned an unexpected payload');
  }
  return normalizeDeepgramResult(parsed);
}

async function uploadAssemblyAiAudio(
  candidate: ProviderCandidate,
  request: NormalizedAudioTranscriptionRequest,
): Promise<string> {
  const response = await fetchWithTimeout(`${candidate.baseUrl}/v2/upload`, {
    method: 'POST',
    headers: {
      Authorization: candidate.apiKey,
      'Content-Type': 'application/octet-stream',
    },
    body: bufferAsBodyInit(request.audio.buffer),
  });
  const parsed = await parseProviderJson(response, 'AssemblyAI');
  if (!isRecord(parsed)) {
    throw new Error('AssemblyAI upload returned an unexpected payload');
  }
  const uploadUrl = readStringValue(parsed.upload_url);
  if (!uploadUrl)
    throw new Error('AssemblyAI upload did not return upload_url');
  return uploadUrl;
}

function normalizeAssemblyAiResult(
  parsed: Record<string, unknown>,
): AudioTranscriptionResult {
  const utterances = Array.isArray(parsed.utterances) ? parsed.utterances : [];
  const words = normalizeWords(
    Array.isArray(parsed.words)
      ? parsed.words.map((word) =>
          isRecord(word)
            ? {
                ...word,
                start:
                  readNumberValue(word.start) == null
                    ? null
                    : (readNumberValue(word.start) as number) / 1000,
                end:
                  readNumberValue(word.end) == null
                    ? null
                    : (readNumberValue(word.end) as number) / 1000,
                speaker: formatSpeaker(word.speaker),
              }
            : word,
        )
      : undefined,
  );
  const segments = utterances
    .map((entry): TranscriptSegment | null => {
      if (!isRecord(entry)) return null;
      const text = readStringValue(entry.text) || '';
      if (!text) return null;
      const startMs = readNumberValue(entry.start);
      const endMs = readNumberValue(entry.end);
      const speaker = formatSpeaker(entry.speaker);
      return {
        start: startMs == null ? null : startMs / 1000,
        end: endMs == null ? null : endMs / 1000,
        text,
        ...(speaker ? { speaker } : {}),
      };
    })
    .filter((entry): entry is TranscriptSegment => Boolean(entry));
  const durationSec = readNumberValue(parsed.audio_duration);
  return {
    text:
      readStringValue(parsed.text) ||
      segments.map((entry) => entry.text).join(' '),
    language:
      readStringValue(parsed.language_code) ||
      readStringValue(parsed.language_detected),
    durationSec,
    segments:
      segments.length > 0
        ? segments
        : buildFallbackSegments(readStringValue(parsed.text), durationSec),
    words,
  };
}

async function transcribeWithAssemblyAi(
  candidate: ProviderCandidate,
  request: NormalizedAudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const audioUrl = request.audio.source.startsWith('https://')
    ? request.audio.source
    : await uploadAssemblyAiAudio(candidate, request);
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    punctuate: true,
    format_text: true,
    language_detection: !request.language,
    speaker_labels: request.diarization,
  };
  if (request.language) body.language_code = request.language;
  if (request.prompt) body.prompt = request.prompt;
  const speakersExpected =
    request.minSpeakers && request.maxSpeakers
      ? request.minSpeakers === request.maxSpeakers
        ? request.minSpeakers
        : null
      : (request.maxSpeakers ?? request.minSpeakers);
  if (speakersExpected) body.speakers_expected = speakersExpected;

  const createResponse = await fetchWithTimeout(
    `${candidate.baseUrl}/v2/transcript`,
    {
      method: 'POST',
      headers: {
        Authorization: candidate.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const created = await parseProviderJson(createResponse, 'AssemblyAI');
  if (!isRecord(created)) {
    throw new Error(
      'AssemblyAI transcript creation returned an unexpected payload',
    );
  }
  const id = readStringValue(created.id);
  if (!id) throw new Error('AssemblyAI transcript creation did not return id');

  const startedAt = Date.now();
  let pollIntervalMs = ASSEMBLYAI_INITIAL_POLL_INTERVAL_MS;
  for (;;) {
    if (Date.now() - startedAt > ASSEMBLYAI_POLL_TIMEOUT_MS) {
      throw new Error('AssemblyAI transcription timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const response = await fetchWithTimeout(
      `${candidate.baseUrl}/v2/transcript/${id}`,
      {
        headers: { Authorization: candidate.apiKey },
      },
      ASSEMBLYAI_POLL_REQUEST_TIMEOUT_MS,
    );
    const parsed = await parseProviderJson(response, 'AssemblyAI');
    if (!isRecord(parsed)) {
      throw new Error(
        'AssemblyAI transcript polling returned an unexpected payload',
      );
    }
    const status = readStringValue(parsed.status);
    if (status === 'completed') return normalizeAssemblyAiResult(parsed);
    if (status === 'error') {
      throw new Error(
        `AssemblyAI transcription failed: ${readStringValue(parsed.error) || 'unknown error'}`,
      );
    }
    pollIntervalMs = Math.min(
      ASSEMBLYAI_MAX_POLL_INTERVAL_MS,
      pollIntervalMs * 2,
    );
  }
}

function collectCandidateWarnings(
  candidate: ProviderCandidate,
  request: NormalizedAudioTranscriptionRequest,
): string[] {
  const warnings: string[] = [];
  if (request.diarization && !candidate.supportsDiarization) {
    warnings.push(
      `${candidate.label} does not support diarization; speaker labels will be omitted.`,
    );
  }
  if (request.timestamps === 'word' && !candidate.supportsWordTimestamps) {
    warnings.push(
      `${candidate.label} does not support word timestamps; segment timestamps will be used.`,
    );
  }
  if (
    request.language &&
    request.detectLanguageOnly &&
    !candidate.supportsLanguageDetection
  ) {
    warnings.push(
      `${candidate.label} does not support language detection; using the provided language hint.`,
    );
  }
  return warnings;
}

async function transcribeWithCandidate(
  candidate: ProviderCandidate,
  request: NormalizedAudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  assertAudioSize(request.audio.buffer, candidate.maxAudioBytes);
  if (candidate.id === 'deepgram')
    return transcribeWithDeepgram(candidate, request);
  if (candidate.id === 'assemblyai')
    return transcribeWithAssemblyAi(candidate, request);
  return transcribeWithOpenAi(candidate, request);
}

function estimateCostUsd(
  durationSec: number | null,
  candidate: ProviderCandidate,
): number | null {
  if (durationSec == null || durationSec < 0) return null;
  return (
    estimateAudioTranscriptionCostUsd({
      provider: candidate.id,
      model: candidate.model,
      audioSeconds: durationSec,
    }) ?? null
  );
}

function runMediaProbe(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function probeAudioDurationSec(filePath: string): number {
  const output = runMediaProbe('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const duration = Number(output);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('ffprobe could not determine audio duration');
  }
  return duration;
}

function createAudioChunks(
  input: AudioInput,
  durationSec: number,
): Array<AudioInput & { offsetSec: number }> {
  if (!input.localPath) {
    throw new Error('long audio chunking requires a local staged audio file');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-stt-'));
  const chunks: Array<AudioInput & { offsetSec: number }> = [];
  const stepSec = Math.max(
    1,
    DEFAULT_CHUNK_WINDOW_SEC - DEFAULT_CHUNK_OVERLAP_SEC,
  );
  try {
    for (let startSec = 0; startSec < durationSec; startSec += stepSec) {
      const duration = Math.min(
        DEFAULT_CHUNK_WINDOW_SEC,
        durationSec - startSec,
      );
      const chunkPath = path.join(
        tempDir,
        `chunk-${String(chunks.length + 1).padStart(4, '0')}.mp3`,
      );
      runMediaProbe('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(startSec),
        '-t',
        String(duration),
        '-i',
        input.localPath,
        '-vn',
        '-acodec',
        'libmp3lame',
        chunkPath,
      ]);
      const buffer = fs.readFileSync(chunkPath);
      assertAudioSize(buffer);
      chunks.push({
        buffer,
        filename: path.basename(chunkPath),
        mimeType: 'audio/mpeg',
        source: `${input.source}#chunk=${chunks.length + 1}`,
        offsetSec: startSec,
      });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return chunks;
}

function offsetSegments(
  segments: TranscriptSegment[],
  offsetSec: number,
): TranscriptSegment[] {
  return segments.map((segment) => ({
    ...segment,
    start: segment.start == null ? null : segment.start + offsetSec,
    end: segment.end == null ? null : segment.end + offsetSec,
  }));
}

function offsetWords(
  words: TranscriptWord[] | undefined,
  offsetSec: number,
): TranscriptWord[] | undefined {
  return words?.map((word) => ({
    ...word,
    start: word.start == null ? null : word.start + offsetSec,
    end: word.end == null ? null : word.end + offsetSec,
  }));
}

export function stitchTranscriptionChunks(
  chunks: Array<AudioTranscriptionResult & { offsetSec: number }>,
  overlapSec = DEFAULT_CHUNK_OVERLAP_SEC,
): AudioTranscriptionResult {
  const segments: TranscriptSegment[] = [];
  const words: TranscriptWord[] = [];
  let language: string | null = null;
  let durationSec: number | null = null;
  for (const chunk of chunks) {
    language ||= chunk.language;
    const chunkEnd =
      chunk.durationSec == null ? null : chunk.offsetSec + chunk.durationSec;
    if (chunkEnd != null) durationSec = Math.max(durationSec || 0, chunkEnd);
    for (const segment of offsetSegments(chunk.segments, chunk.offsetSec)) {
      const duplicate =
        chunk.offsetSec > 0 &&
        segment.start != null &&
        segment.start < chunk.offsetSec + overlapSec;
      if (!duplicate) segments.push(segment);
    }
    for (const word of offsetWords(chunk.words, chunk.offsetSec) || []) {
      const duplicate =
        chunk.offsetSec > 0 &&
        word.start != null &&
        word.start < chunk.offsetSec + overlapSec;
      if (!duplicate) words.push(word);
    }
  }
  return {
    text: segments
      .map((segment) => segment.text)
      .join(' ')
      .trim(),
    language,
    durationSec,
    segments,
    ...(words.length > 0 ? { words } : {}),
  };
}

async function transcribePossiblyChunked(
  candidate: ProviderCandidate,
  request: NormalizedAudioTranscriptionRequest,
): Promise<CandidateTranscriptionResult> {
  const warnings = collectCandidateWarnings(candidate, request);
  let durationSec: number | null = null;
  let shouldChunk = request.audio.buffer.length > candidate.maxAudioBytes;
  if (candidate.id === 'openai' && request.audio.localPath) {
    try {
      durationSec = probeAudioDurationSec(request.audio.localPath);
      shouldChunk ||= durationSec > DEFAULT_CHUNK_WINDOW_SEC;
    } catch (error) {
      if (shouldChunk) {
        throw new Error(
          `audio duration probe failed; cannot chunk oversized audio: ${sanitizeProviderError(error)}`,
        );
      }
      warnings.push(
        `audio duration probe failed; chunking was skipped: ${sanitizeProviderError(error)}`,
      );
    }
  }
  if (!shouldChunk) {
    return {
      result: await transcribeWithCandidate(candidate, request),
      warnings,
    };
  }
  if (durationSec == null) {
    if (!request.audio.localPath) {
      throw new Error('long audio chunking requires a local staged audio file');
    }
    durationSec = probeAudioDurationSec(request.audio.localPath);
  }
  const chunks = createAudioChunks(request.audio, durationSec);
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const chunkResult = await transcribeWithCandidate(candidate, {
        ...request,
        audio: chunk,
      });
      return { ...chunkResult, offsetSec: chunk.offsetSec };
    }),
  );
  warnings.push(
    `audio was split into ${chunks.length} chunks with ${DEFAULT_CHUNK_OVERLAP_SEC}s overlap.`,
  );
  return {
    result: stitchTranscriptionChunks(results, DEFAULT_CHUNK_OVERLAP_SEC),
    warnings,
  };
}

function persistTranscript(params: {
  result: AudioTranscriptionResult;
  provider: ProviderCandidate;
  source: string;
  costUsd: number | null;
}): Array<Record<string, unknown>> {
  const outputRoot = path.join(WORKSPACE_ROOT, OUTPUT_DIR);
  fs.mkdirSync(outputRoot, { recursive: true });
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const textFilename = `transcript-${stamp}.txt`;
  const jsonFilename = `transcript-${stamp}.json`;
  const textPath = path.join(outputRoot, textFilename);
  const jsonPath = path.join(outputRoot, jsonFilename);
  fs.writeFileSync(textPath, params.result.text, 'utf-8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        text: params.result.text,
        segments: params.result.segments,
        ...(params.result.words ? { words: params.result.words } : {}),
        language: params.result.language,
        provider: params.provider.id,
        model: params.provider.model,
        duration_sec: params.result.durationSec,
        cost_usd: params.costUsd,
        source: params.source,
      },
      null,
      2,
    ),
    'utf-8',
  );
  return [
    {
      path: `${WORKSPACE_ROOT_DISPLAY}/${OUTPUT_DIR}/${textFilename}`,
      filename: textFilename,
      mimeType: 'text/plain',
    },
    {
      path: `${WORKSPACE_ROOT_DISPLAY}/${OUTPUT_DIR}/${jsonFilename}`,
      filename: jsonFilename,
      mimeType: 'application/json',
    },
  ];
}

function sanitizeProviderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function cleanupAudioInput(input: AudioInput): void {
  if (!input.cleanupPath) return;
  fs.rmSync(input.cleanupPath, { recursive: true, force: true });
}

export async function runAudioTranscribe(
  args: Record<string, unknown>,
  context: AudioTranscriptionRuntimeContext,
): Promise<string> {
  const action = readStringValue(args.action)?.toLowerCase();
  if (action === 'list') {
    return JSON.stringify(listAudioTranscriptionProviders(context), null, 2);
  }

  const request = await normalizeRequest(args, context);
  const candidates = buildProviderCandidates(context, request.provider);
  if (candidates.length === 0) {
    throw new Error(
      request.provider
        ? `audio_transcribe provider "${request.provider}" is not configured. Store the provider API key with \`hybridclaw secret set\` or use provider "auto".`
        : 'audio_transcribe is not configured: store OPENAI_API_KEY, DEEPGRAM_API_KEY, or ASSEMBLYAI_API_KEY with `hybridclaw secret set`, or use a configured openai-codex model.',
    );
  }

  try {
    const attempts: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index] as ProviderCandidate;
      try {
        const { result, warnings } = await transcribePossiblyChunked(
          candidate,
          request,
        );
        const costUsd = estimateCostUsd(result.durationSec, candidate);
        const artifacts = request.detectLanguageOnly
          ? []
          : persistTranscript({
              result,
              provider: candidate,
              source: request.audio.source,
              costUsd,
            });
        attempts.push({
          provider: candidate.id,
          model: candidate.model,
          success: true,
        });
        const transcriptPayload = request.detectLanguageOnly
          ? {}
          : {
              text: result.text,
              segments: result.segments,
              ...(result.words ? { words: result.words } : {}),
              artifacts,
            };
        return JSON.stringify(
          {
            success: true,
            provider: candidate.id,
            model: candidate.model,
            action: request.detectLanguageOnly
              ? 'detect-language'
              : 'transcribe',
            ...transcriptPayload,
            language: result.language,
            duration_sec: result.durationSec,
            cost_usd: costUsd,
            usage: {
              audio_seconds: result.durationSec,
              cost_usd: costUsd,
              estimated: costUsd != null,
            },
            warnings: [...request.warnings, ...warnings],
            attempts,
            source: request.audio.source,
          },
          null,
          2,
        );
      } catch (error) {
        const detail = sanitizeProviderError(error);
        const fallbackReason = classifyProviderError(error);
        errors.push(`${candidate.id}: ${detail}`);
        attempts.push({
          provider: candidate.id,
          model: candidate.model,
          success: false,
          error: detail,
          fallback_reason: fallbackReason,
        });
        if (!shouldFallbackProviderError(error)) {
          throw error;
        }
        if (index === candidates.length - 1) break;
      }
    }

    throw new Error(
      `all audio transcription providers failed: ${errors.join(' | ')}`,
    );
  } finally {
    cleanupAudioInput(request.audio);
  }
}
