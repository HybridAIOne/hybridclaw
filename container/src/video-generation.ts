import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeProvider } from './providers/provider-ids.js';
import { ProviderRequestError } from './providers/shared.js';
import { WORKSPACE_ROOT, WORKSPACE_ROOT_DISPLAY } from './runtime-paths.js';
import type { ProviderCredentials } from './types.js';

type VideoGenerationProviderId = 'openai' | 'gemini';

export interface VideoGenerationRuntimeContext {
  provider: RuntimeProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  requestHeaders?: Record<string, string>;
  providerCredentials?: ProviderCredentials;
}

interface ProviderCandidate {
  id: VideoGenerationProviderId;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  requestHeaders?: Record<string, string>;
}

interface NormalizedVideoGenerationRequest {
  prompt: string;
  aspectRatio: string | null;
  resolution: string | null;
  durationSeconds: number | null;
  warnings: string[];
}

interface GeneratedVideoBuffer {
  buffer: Buffer;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

interface VideoGenerationUsage {
  generated_videos?: number;
  duration_seconds?: number;
  estimated?: boolean;
}

const OUTPUT_DIR = '.generated-videos';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_OPENAI_VIDEO_MODEL = 'sora-2-pro';
const DEFAULT_GEMINI_VIDEO_MODEL = 'veo-3.1-fast-generate-preview';
const PROVIDER_API_TIMEOUT_MS = 10 * 60_000;
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_POLL_TIMEOUT_MS = 15 * 60_000;
const MAX_GENERATED_VIDEO_BYTES = 512 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeBaseUrl(value: string, fallback: string): string {
  const trimmed = String(value || '').trim() || fallback;
  return trimmed.replace(/\/+$/, '');
}

function stripProviderPrefix(model: string, provider: string): string {
  const trimmed = String(model || '').trim();
  const prefix = `${provider}/`;
  if (trimmed.toLowerCase().startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function hasVideoModelHint(model: string): boolean {
  return /sora|veo|video/i.test(model);
}

function readCredentialValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function providerCredentials(
  context: VideoGenerationRuntimeContext,
  provider: VideoGenerationProviderId,
) {
  return context.providerCredentials?.[provider] || {};
}

function normalizeAspectRatio(value: unknown): string | null {
  const raw = readStringValue(value);
  if (!raw) return null;
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  if (/^\d+:\d+$/.test(compact)) return compact;
  if (compact === 'landscape') return '16:9';
  if (compact === 'portrait') return '9:16';
  return raw;
}

function normalizeRequest(
  args: Record<string, unknown>,
): NormalizedVideoGenerationRequest {
  const prompt = readStringValue(args.prompt);
  if (!prompt) throw new Error('video_generate requires a prompt.');
  const durationSeconds = readNumberValue(
    args.durationSeconds ?? args.duration,
  );
  return {
    prompt,
    aspectRatio: normalizeAspectRatio(args.aspectRatio ?? args.aspect_ratio),
    resolution: readStringValue(args.resolution ?? args.size),
    durationSeconds:
      durationSeconds && durationSeconds > 0
        ? Math.floor(durationSeconds)
        : null,
    warnings: [],
  };
}

function candidateFromCurrentContext(
  context: VideoGenerationRuntimeContext,
): ProviderCandidate | null {
  if (!context.apiKey) return null;
  if (context.provider === 'openai-codex') {
    const model = stripProviderPrefix(context.model, 'openai-codex');
    return {
      id: 'openai',
      label: 'OpenAI / Codex',
      apiKey: context.apiKey,
      baseUrl: normalizeBaseUrl(context.baseUrl, DEFAULT_OPENAI_BASE_URL),
      model: hasVideoModelHint(model) ? model : DEFAULT_OPENAI_VIDEO_MODEL,
      requestHeaders: context.requestHeaders,
    };
  }
  if (context.provider === 'gemini') {
    const model = stripProviderPrefix(context.model, 'gemini');
    return {
      id: 'gemini',
      label: 'Google Gemini',
      apiKey: context.apiKey,
      baseUrl: normalizeBaseUrl(context.baseUrl, DEFAULT_GEMINI_BASE_URL),
      model: hasVideoModelHint(model) ? model : DEFAULT_GEMINI_VIDEO_MODEL,
      requestHeaders: context.requestHeaders,
    };
  }
  return null;
}

function buildProviderCandidates(
  context: VideoGenerationRuntimeContext,
): ProviderCandidate[] {
  const candidates: ProviderCandidate[] = [];
  const configured: ProviderCandidate[] = [];
  const openaiConfig = providerCredentials(context, 'openai');
  const openaiKey = readCredentialValue(openaiConfig.apiKey);
  if (openaiKey) {
    configured.push({
      id: 'openai',
      label: 'OpenAI',
      apiKey: openaiKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(openaiConfig.baseUrl),
        DEFAULT_OPENAI_BASE_URL,
      ),
      model:
        readCredentialValue(openaiConfig.videoModel) ||
        DEFAULT_OPENAI_VIDEO_MODEL,
    });
  }

  const geminiConfig = providerCredentials(context, 'gemini');
  const geminiKey = readCredentialValue(geminiConfig.apiKey);
  if (geminiKey) {
    configured.push({
      id: 'gemini',
      label: 'Google Gemini',
      apiKey: geminiKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(geminiConfig.baseUrl),
        DEFAULT_GEMINI_BASE_URL,
      ),
      model:
        readCredentialValue(geminiConfig.videoModel) ||
        DEFAULT_GEMINI_VIDEO_MODEL,
    });
  }

  const current = candidateFromCurrentContext(context);
  if (current && !configured.some((entry) => entry.id === current.id))
    candidates.push(current);
  candidates.push(...configured);

  return candidates;
}

export function listVideoGenerationProviders(
  context: VideoGenerationRuntimeContext,
): Record<string, unknown> {
  const candidates = buildProviderCandidates(context);
  const ready = new Set(candidates.map((entry) => entry.id));
  const active = candidateFromCurrentContext(context)?.id || null;
  const providers = [
    {
      id: 'openai',
      label: 'OpenAI / Codex',
      ready: ready.has('openai'),
      active: active === 'openai',
      missing: ready.has('openai')
        ? null
        : 'Store OPENAI_API_KEY with `hybridclaw secret set OPENAI_API_KEY <key>` or in TUI with `/secret set OPENAI_API_KEY <key>`, or use an openai-codex model with credentials.',
      default_model: DEFAULT_OPENAI_VIDEO_MODEL,
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      ready: ready.has('gemini'),
      active: active === 'gemini',
      missing: ready.has('gemini')
        ? null
        : 'Store GEMINI_API_KEY or GOOGLE_API_KEY with `hybridclaw secret set <name> <key>` or in TUI with `/secret set <name> <key>`, or use a configured gemini model.',
      default_model: DEFAULT_GEMINI_VIDEO_MODEL,
    },
  ];
  return {
    success: true,
    action: 'list',
    providers,
    configured_count: providers.filter((entry) => entry.ready).length,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const rawText = await response.text();
    if (!response.ok) throw new ProviderRequestError(response.status, rawText);
    const parsed = JSON.parse(rawText) as unknown;
    if (isRecord(parsed)) return parsed;
    throw new Error('provider returned invalid JSON');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `provider API request timed out after ${PROVIDER_API_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function authJsonHeaders(candidate: ProviderCandidate): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${candidate.apiKey}`,
    ...(candidate.requestHeaders || {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFirstStringByKey(value: unknown, key: string): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirstStringByKey(entry, key);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const direct = readStringValue(value[key]);
  if (direct) return direct;
  for (const entry of Object.values(value)) {
    const found = findFirstStringByKey(entry, key);
    if (found) return found;
  }
  return null;
}

async function readLimitedResponseBuffer(response: Response): Promise<Buffer> {
  const contentLength = Number.parseInt(
    response.headers.get('content-length') || '',
    10,
  );
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_GENERATED_VIDEO_BYTES
  ) {
    throw new Error(
      `generated video exceeds max size (${MAX_GENERATED_VIDEO_BYTES} bytes)`,
    );
  }

  const body = response.body;
  if (body && typeof body === 'object' && 'getReader' in body) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        bytesRead += value.byteLength;
        if (bytesRead > MAX_GENERATED_VIDEO_BYTES) {
          throw new Error(
            `generated video exceeds max size (${MAX_GENERATED_VIDEO_BYTES} bytes)`,
          );
        }
        chunks.push(value);
      }
    } finally {
      if (bytesRead > MAX_GENERATED_VIDEO_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation failures after enforcing the byte cap.
        }
      }
    }
    return Buffer.concat(chunks, bytesRead);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_GENERATED_VIDEO_BYTES) {
    throw new Error(
      `generated video exceeds max size (${MAX_GENERATED_VIDEO_BYTES} bytes)`,
    );
  }
  return buffer;
}

async function fetchBinary(
  url: string,
  init: RequestInit,
): Promise<GeneratedVideoBuffer> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`provider video download failed (${response.status})`);
  }
  const mimeType = response.headers.get('content-type') || 'video/mp4';
  return { buffer: await readLimitedResponseBuffer(response), mimeType };
}

async function pollOpenAiVideo(
  candidate: ProviderCandidate,
  videoId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await fetchJson(`${candidate.baseUrl}/videos/${videoId}`, {
      method: 'GET',
      headers: authJsonHeaders(candidate),
    });
    const status = readStringValue(payload.status)?.toLowerCase() || '';
    if (status === 'completed' || status === 'succeeded') return payload;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(
        `OpenAI video generation failed: ${JSON.stringify(payload)}`,
      );
    }
    await sleep(VIDEO_POLL_INTERVAL_MS);
  }
  throw new Error(
    `OpenAI video generation timed out after ${VIDEO_POLL_TIMEOUT_MS}ms`,
  );
}

async function generateWithOpenAi(
  candidate: ProviderCandidate,
  request: NormalizedVideoGenerationRequest,
): Promise<GeneratedVideoBuffer[]> {
  const body: Record<string, unknown> = {
    model: candidate.model,
    prompt: request.prompt,
  };
  if (request.resolution) body.size = request.resolution;
  if (request.durationSeconds) body.seconds = request.durationSeconds;
  const start = await fetchJson(`${candidate.baseUrl}/videos`, {
    method: 'POST',
    headers: authJsonHeaders(candidate),
    body: JSON.stringify(body),
  });
  const videoId = readStringValue(start.id);
  if (!videoId) throw new Error('OpenAI response did not include a video id');
  await pollOpenAiVideo(candidate, videoId);
  const video = await fetchBinary(
    `${candidate.baseUrl}/videos/${encodeURIComponent(videoId)}/content?variant=video`,
    { headers: { Authorization: `Bearer ${candidate.apiKey}` } },
  );
  video.metadata = { video_id: videoId };
  return [video];
}

async function pollGeminiOperation(
  candidate: ProviderCandidate,
  operationName: string,
): Promise<Record<string, unknown>> {
  const baseUrl = candidate.baseUrl.replace(/\/openai$/i, '');
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await fetchJson(`${baseUrl}/${operationName}`, {
      method: 'GET',
      headers: {
        'x-goog-api-key': candidate.apiKey,
        ...(candidate.requestHeaders || {}),
      },
    });
    if (payload.done === true) return payload;
    await sleep(VIDEO_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Gemini video generation timed out after ${VIDEO_POLL_TIMEOUT_MS}ms`,
  );
}

async function generateWithGemini(
  candidate: ProviderCandidate,
  request: NormalizedVideoGenerationRequest,
): Promise<GeneratedVideoBuffer[]> {
  const baseUrl = candidate.baseUrl.replace(/\/openai$/i, '');
  const parameters: Record<string, unknown> = {};
  if (request.aspectRatio) parameters.aspectRatio = request.aspectRatio;
  if (request.resolution) parameters.resolution = request.resolution;
  if (request.durationSeconds)
    parameters.durationSeconds = request.durationSeconds;
  const start = await fetchJson(
    `${baseUrl}/models/${encodeURIComponent(candidate.model)}:predictLongRunning`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': candidate.apiKey,
        ...(candidate.requestHeaders || {}),
      },
      body: JSON.stringify({
        instances: [{ prompt: request.prompt }],
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      }),
    },
  );
  const operationName = readStringValue(start.name);
  if (!operationName)
    throw new Error('Gemini response did not include an operation name');
  const done = await pollGeminiOperation(candidate, operationName);
  const videoUri = findFirstStringByKey(done.response, 'uri');
  if (!videoUri) throw new Error('Gemini response did not include a video URI');
  const video = await fetchBinary(videoUri, {
    headers: { 'x-goog-api-key': candidate.apiKey },
  });
  video.metadata = { operation_name: operationName, source_url: videoUri };
  return [video];
}

async function generateWithCandidate(
  candidate: ProviderCandidate,
  request: NormalizedVideoGenerationRequest,
): Promise<GeneratedVideoBuffer[]> {
  if (candidate.id === 'gemini') return generateWithGemini(candidate, request);
  return generateWithOpenAi(candidate, request);
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('quicktime')) return '.mov';
  return '.mp4';
}

function persistVideos(
  videos: GeneratedVideoBuffer[],
  provider: ProviderCandidate,
): Array<Record<string, unknown>> {
  const outputRoot = path.join(WORKSPACE_ROOT, OUTPUT_DIR);
  fs.mkdirSync(outputRoot, { recursive: true });
  return videos.map((video, index) => {
    const ext = extensionFromMimeType(video.mimeType);
    const filename = `video-${Date.now()}-${index + 1}-${randomUUID().slice(0, 8)}${ext}`;
    const hostPath = path.join(outputRoot, filename);
    fs.writeFileSync(hostPath, video.buffer);
    const displayPath = `${WORKSPACE_ROOT_DISPLAY}/${OUTPUT_DIR}/${filename}`;
    return {
      path: displayPath,
      filename,
      mimeType: video.mimeType,
      bytes: video.buffer.length,
      provider: provider.id,
      model: provider.model,
      ...(video.metadata ? { metadata: video.metadata } : {}),
    };
  });
}

function sanitizeProviderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildVideoUsage(
  generatedVideos: number,
  durationSeconds: number | null,
): VideoGenerationUsage {
  return {
    generated_videos: generatedVideos,
    ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}),
    estimated: true,
  };
}

export async function runVideoGenerate(
  args: Record<string, unknown>,
  context: VideoGenerationRuntimeContext,
): Promise<string> {
  const action = readStringValue(args.action)?.toLowerCase();
  if (action === 'list') {
    return JSON.stringify(listVideoGenerationProviders(context), null, 2);
  }

  const request = normalizeRequest(args);
  const candidates = buildProviderCandidates(context);
  if (candidates.length === 0) {
    throw new Error(
      'video_generate is not configured: store the provider API key with `hybridclaw secret set <name> <key>` or in TUI with `/secret set <name> <key>`, or use a configured openai-codex/gemini model.',
    );
  }

  const attempts: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const providerWarnings = [...request.warnings];
      if (candidate.id === 'openai' && request.aspectRatio) {
        providerWarnings.push(
          'OpenAI video generation expects size/resolution; aspectRatio was ignored.',
        );
      }
      const videos = await generateWithCandidate(candidate, request);
      const persisted = persistVideos(videos, candidate);
      attempts.push({
        provider: candidate.id,
        model: candidate.model,
        success: true,
      });
      return JSON.stringify(
        {
          success: true,
          provider: candidate.id,
          model: candidate.model,
          videos: persisted,
          usage: buildVideoUsage(persisted.length, request.durationSeconds),
          artifacts: persisted,
          warnings: providerWarnings,
          attempts,
        },
        null,
        2,
      );
    } catch (error) {
      const message = sanitizeProviderError(error);
      errors.push(`${candidate.label}: ${message}`);
      attempts.push({
        provider: candidate.id,
        model: candidate.model,
        success: false,
        error: message,
      });
    }
  }

  throw new Error(
    `video_generate failed for all configured providers. ${errors.join(' | ')}`,
  );
}
