import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isSafeDiscordCdnUrl } from './discord-cdn.js';
import type { RuntimeProvider } from './providers/provider-ids.js';
import { ProviderRequestError } from './providers/shared.js';
import {
  DISCORD_MEDIA_CACHE_ROOT,
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  resolveMediaPath,
  resolveWorkspacePath,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';
import type { MediaContextItem, ProviderCredentials } from './types.js';

type ImageGenerationProviderId = 'openai' | 'gemini' | 'xai' | 'bfl';

export interface ImageGenerationRuntimeContext {
  provider: RuntimeProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  requestHeaders?: Record<string, string>;
  media: MediaContextItem[];
  providerCredentials?: ProviderCredentials;
}

interface ImageReference {
  buffer: Buffer;
  mimeType: string;
  source: string;
}

interface ProviderCandidate {
  id: ImageGenerationProviderId;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  requestHeaders?: Record<string, string>;
}

interface NormalizedImageGenerationRequest {
  prompt: string;
  count: number;
  size: string | null;
  aspectRatio: string | null;
  quality: string | null;
  references: ImageReference[];
  warnings: string[];
}

interface GeneratedImageBuffer {
  buffer: Buffer;
  mimeType: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
}

const OUTPUT_DIR = '.generated-images';
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_TOTAL_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const PROVIDER_API_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_BFL_BASE_URL = 'https://api.bfl.ai/v1';
const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2';
const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const DEFAULT_XAI_IMAGE_MODEL = 'grok-imagine-image-quality';
const DEFAULT_BFL_IMAGE_MODEL = 'flux-2-pro-preview';
const BFL_POLL_INTERVAL_MS = 1_000;
const BFL_POLL_TIMEOUT_MS = 10 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readStringListValue(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readStringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function readCount(value: unknown, warnings: string[]): number {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : 1;
  if (!Number.isFinite(raw) || raw < 1) {
    warnings.push('count must be a positive number; using 1.');
    return 1;
  }
  const rounded = Math.floor(raw);
  if (rounded > 4) {
    warnings.push(
      'count was capped at 4 for the first image_generate version.',
    );
    return 4;
  }
  return rounded;
}

function normalizeAspectRatio(value: unknown): string | null {
  const raw = readStringValue(value);
  if (!raw) return null;
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  if (/^\d+:\d+$/.test(compact)) return compact;
  if (compact === 'square') return '1:1';
  if (compact === 'landscape') return '3:2';
  if (compact === 'portrait') return '2:3';
  return raw;
}

function sizeFromAspectRatio(aspectRatio: string | null): string | null {
  if (!aspectRatio) return null;
  const match = aspectRatio.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.1) return '1024x1024';
  return ratio > 1 ? '1536x1024' : '1024x1536';
}

function normalizeSize(args: Record<string, unknown>, warnings: string[]) {
  const direct =
    readStringValue(args.size) || readStringValue(args.resolution) || null;
  const aspectRatio = normalizeAspectRatio(
    args.aspectRatio ?? args.aspect_ratio,
  );
  if (direct) return { size: direct, aspectRatio };
  const derived = sizeFromAspectRatio(aspectRatio);
  if (!derived && aspectRatio) {
    warnings.push(
      `aspectRatio "${aspectRatio}" is unsupported; using provider default size.`,
    );
  }
  return { size: derived, aspectRatio };
}

function inferImageMimeType(
  filePath: string,
  fallback?: string | null,
): string {
  const normalizedFallback = String(fallback || '')
    .trim()
    .toLowerCase();
  if (normalizedFallback.startsWith('image/')) return normalizedFallback;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  return '.png';
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
    words.some(
      (word, index) =>
        !/^[0-9a-f]{1,4}$/i.test(parts[index] ?? '') ||
        Number.isNaN(word) ||
        word < 0 ||
        word > 0xffff,
    )
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

function isPrivateIpv6(ip: string): boolean {
  const lower = (ip.split('%')[0] ?? '').toLowerCase();
  if (lower === '::') return true;
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = decodeIpv4MappedIpv6Tail(lower.slice('::ffff:'.length));
    return mapped ? isPrivateIpv4(mapped) : false;
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  const normalized = normalizeHostname(ip);
  const version = net.isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version === 6) return isPrivateIpv6(normalized);
  return false;
}

async function assertPublicHttpsProviderImageUrl(rawUrl: string): Promise<URL> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error('provider image URL is invalid');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('provider image URL must use https');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('provider image URL must not include credentials');
  }

  const host = normalizeHostname(parsedUrl.hostname);
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    throw new Error(
      `provider image URL blocked: private or loopback host (${host})`,
    );
  }
  if (net.isIP(host) > 0) {
    if (isPrivateIp(host)) {
      throw new Error(
        `provider image URL blocked: private or loopback host (${host})`,
      );
    }
    return parsedUrl;
  }

  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.length === 0) {
      throw new Error(
        `provider image URL blocked: DNS lookup failed (${host})`,
      );
    }
    if (resolved.some((entry) => isPrivateIp(entry.address))) {
      throw new Error(
        `provider image URL blocked: private or loopback host (${host})`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('provider image URL blocked:')
    ) {
      throw error;
    }
    throw new Error(`provider image URL blocked: DNS lookup failed (${host})`);
  }

  return parsedUrl;
}

function normalizeLocalReferencePath(rawPath: string): string | null {
  return resolveWorkspacePath(rawPath) || resolveMediaPath(rawPath);
}

function knownMediaPathSet(media: MediaContextItem[]): Set<string> {
  const paths = new Set<string>();
  for (const item of media) {
    const rawPath = typeof item.path === 'string' ? item.path.trim() : '';
    if (!rawPath) continue;
    const normalized = normalizeLocalReferencePath(rawPath);
    if (normalized) paths.add(normalized);
  }
  return paths;
}

async function readLocalReferenceImage(
  rawPath: string,
  media: MediaContextItem[],
): Promise<ImageReference> {
  const normalizedPath = normalizeLocalReferencePath(rawPath);
  if (!normalizedPath) {
    throw new Error(
      `reference image path must be under ${WORKSPACE_ROOT_DISPLAY}, ${DISCORD_MEDIA_CACHE_ROOT_DISPLAY}, or /uploaded-media-cache`,
    );
  }

  if (normalizedPath.startsWith(`${DISCORD_MEDIA_CACHE_ROOT}/`)) {
    const knownPaths = knownMediaPathSet(media);
    if (knownPaths.size > 0 && !knownPaths.has(normalizedPath)) {
      throw new Error('reference image is not part of current media context');
    }
  }

  const stat = fs.statSync(normalizedPath, { throwIfNoEntry: false });
  if (!stat) throw new Error(`reference image not found: ${normalizedPath}`);
  if (!stat.isFile()) {
    throw new Error(`reference image path is not a file: ${normalizedPath}`);
  }
  if (stat.size <= 0)
    throw new Error(`reference image is empty: ${normalizedPath}`);
  if (stat.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(
      `reference image exceeds max size (${MAX_REFERENCE_IMAGE_BYTES} bytes)`,
    );
  }
  const mimeType = inferImageMimeType(normalizedPath);
  if (!mimeType.startsWith('image/')) {
    throw new Error(`unsupported reference image type: ${mimeType}`);
  }
  return {
    buffer: fs.readFileSync(normalizedPath),
    mimeType,
    source: normalizedPath,
  };
}

async function readRemoteReferenceImage(
  rawUrl: string,
): Promise<ImageReference> {
  if (!isSafeDiscordCdnUrl(rawUrl)) {
    throw new Error(
      'remote reference image URL is blocked (only Discord CDN HTTPS URLs are allowed)',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(rawUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`reference image download failed (${response.status})`);
    }
    const mimeType = String(response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw new Error(
        `remote reference is not an image (${mimeType || 'unknown'})`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(
        `reference image exceeds max size (${MAX_REFERENCE_IMAGE_BYTES} bytes)`,
      );
    }
    return { buffer, mimeType, source: rawUrl };
  } finally {
    clearTimeout(timer);
  }
}

async function loadReferenceImages(
  args: Record<string, unknown>,
  media: MediaContextItem[],
): Promise<ImageReference[]> {
  const refs = [
    ...readStringListValue(args.images),
    ...readStringListValue(args.image),
  ];
  const out: ImageReference[] = [];
  for (const ref of refs) {
    out.push(
      /^https?:\/\//i.test(ref)
        ? await readRemoteReferenceImage(ref)
        : await readLocalReferenceImage(ref, media),
    );
  }
  return out;
}

async function normalizeRequest(
  args: Record<string, unknown>,
  context: ImageGenerationRuntimeContext,
): Promise<NormalizedImageGenerationRequest> {
  const warnings: string[] = [];
  const prompt = readStringValue(args.prompt);
  if (!prompt) throw new Error('prompt is required');
  const count = readCount(args.count, warnings);
  const { size, aspectRatio } = normalizeSize(args, warnings);
  const quality = readStringValue(args.quality)?.toLowerCase() || null;
  const references = await loadReferenceImages(args, context.media);
  return {
    prompt,
    count,
    size,
    aspectRatio,
    quality,
    references,
    warnings,
  };
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

function hasImageModelHint(model: string): boolean {
  return /image|gpt-image|nano-banana|flux/i.test(model);
}

function readCredentialValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function providerCredentials(
  context: ImageGenerationRuntimeContext,
  provider: ImageGenerationProviderId,
) {
  return context.providerCredentials?.[provider] || {};
}

function candidateFromCurrentContext(
  context: ImageGenerationRuntimeContext,
): ProviderCandidate | null {
  if (!context.apiKey) return null;
  if (context.provider === 'openai-codex') {
    const model = stripProviderPrefix(context.model, 'openai-codex');
    return {
      id: 'openai',
      label: 'OpenAI / Codex',
      apiKey: context.apiKey,
      baseUrl: normalizeBaseUrl(context.baseUrl, DEFAULT_OPENAI_BASE_URL),
      model: hasImageModelHint(model) ? model : DEFAULT_OPENAI_IMAGE_MODEL,
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
      model: hasImageModelHint(model) ? model : DEFAULT_GEMINI_IMAGE_MODEL,
      requestHeaders: context.requestHeaders,
    };
  }
  if (context.provider === 'xai') {
    const model = stripProviderPrefix(context.model, 'xai');
    return {
      id: 'xai',
      label: 'xAI',
      apiKey: context.apiKey,
      baseUrl: normalizeBaseUrl(context.baseUrl, DEFAULT_XAI_BASE_URL),
      model: hasImageModelHint(model) ? model : DEFAULT_XAI_IMAGE_MODEL,
      requestHeaders: context.requestHeaders,
    };
  }
  return null;
}

function buildProviderCandidates(
  context: ImageGenerationRuntimeContext,
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
        readCredentialValue(openaiConfig.imageModel) ||
        DEFAULT_OPENAI_IMAGE_MODEL,
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
        readCredentialValue(geminiConfig.imageModel) ||
        DEFAULT_GEMINI_IMAGE_MODEL,
    });
  }

  const xaiConfig = providerCredentials(context, 'xai');
  const xaiKey = readCredentialValue(xaiConfig.apiKey);
  if (xaiKey) {
    configured.push({
      id: 'xai',
      label: 'xAI',
      apiKey: xaiKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(xaiConfig.baseUrl),
        DEFAULT_XAI_BASE_URL,
      ),
      model:
        readCredentialValue(xaiConfig.imageModel) || DEFAULT_XAI_IMAGE_MODEL,
    });
  }

  const bflConfig = providerCredentials(context, 'bfl');
  const bflKey = readCredentialValue(bflConfig.apiKey);
  if (bflKey) {
    configured.push({
      id: 'bfl',
      label: 'Black Forest Labs',
      apiKey: bflKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(bflConfig.baseUrl),
        DEFAULT_BFL_BASE_URL,
      ),
      model:
        readCredentialValue(bflConfig.imageModel) || DEFAULT_BFL_IMAGE_MODEL,
    });
  }

  const current = candidateFromCurrentContext(context);
  if (current && !configured.some((entry) => entry.id === current.id))
    candidates.push(current);
  candidates.push(...configured);

  return candidates;
}

export function listImageGenerationProviders(
  context: ImageGenerationRuntimeContext,
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
        : 'Set OPENAI_API_KEY or use an openai-codex model with credentials.',
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      ready: ready.has('gemini'),
      active: active === 'gemini',
      missing: ready.has('gemini')
        ? null
        : 'Set GEMINI_API_KEY/GOOGLE_API_KEY or use a configured gemini model.',
    },
    {
      id: 'xai',
      label: 'xAI',
      ready: ready.has('xai'),
      active: active === 'xai',
      missing: ready.has('xai')
        ? null
        : 'Set XAI_API_KEY or use a configured xai model.',
    },
    {
      id: 'bfl',
      label: 'Black Forest Labs',
      ready: ready.has('bfl'),
      active: active === 'bfl',
      missing: ready.has('bfl')
        ? null
        : 'Set BFL_API_KEY/BLACK_FOREST_LABS_API_KEY.',
      default_model: DEFAULT_BFL_IMAGE_MODEL,
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
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall through to structured error below.
    }
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

function findBase64Images(value: unknown): string[] {
  if (typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return value.length > 200 ? [value] : [];
  }
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(findBase64Images);
  const record = value as Record<string, unknown>;
  const direct =
    readStringValue(record.b64_json) ||
    readStringValue(record.b64Json) ||
    readStringValue(record.result);
  const directImages = direct ? [direct] : [];
  return [
    ...directImages,
    ...Object.entries(record)
      .filter(([key]) => !['b64_json', 'b64Json', 'result'].includes(key))
      .flatMap(([, entry]) => findBase64Images(entry)),
  ];
}

function readRevisedPrompt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.revised_prompt === 'string') return value.revised_prompt;
  if (typeof value.revisedPrompt === 'string') return value.revisedPrompt;
  const data = Array.isArray(value.data) ? value.data : [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    if (typeof entry.revised_prompt === 'string') return entry.revised_prompt;
    if (typeof entry.revisedPrompt === 'string') return entry.revisedPrompt;
  }
  return undefined;
}

async function fetchProviderImageUrl(rawUrl: string): Promise<Buffer> {
  const safeUrl = await assertPublicHttpsProviderImageUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(safeUrl, {
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('provider image redirects are blocked');
    }
    if (!response.ok) {
      throw new Error(`provider image download failed (${response.status})`);
    }
    return await readLimitedImageResponseBuffer(response);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `provider image download timed out after ${FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedImageResponseBuffer(
  response: Response,
): Promise<Buffer> {
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`provider image URL is not an image (${contentType})`);
  }

  const contentLength = Number.parseInt(
    response.headers.get('content-length') || '',
    10,
  );
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_GENERATED_IMAGE_BYTES
  ) {
    throw new Error(
      `generated image exceeds max size (${MAX_GENERATED_IMAGE_BYTES} bytes)`,
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
        if (bytesRead > MAX_GENERATED_IMAGE_BYTES) {
          throw new Error(
            `generated image exceeds max size (${MAX_GENERATED_IMAGE_BYTES} bytes)`,
          );
        }
        chunks.push(value);
      }
    } finally {
      if (bytesRead > MAX_GENERATED_IMAGE_BYTES) {
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
  assertGeneratedImageSize(buffer);
  return buffer;
}

function assertGeneratedImageSize(buffer: Buffer): void {
  if (buffer.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(
      `generated image exceeds max size (${MAX_GENERATED_IMAGE_BYTES} bytes)`,
    );
  }
}

function decodeGeneratedImageBase64(value: string): Buffer {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor((value.length * 3) / 4) - padding;
  if (estimatedBytes > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(
      `generated image exceeds max size (${MAX_GENERATED_IMAGE_BYTES} bytes)`,
    );
  }
  const buffer = Buffer.from(value, 'base64');
  assertGeneratedImageSize(buffer);
  return buffer;
}

async function parseOpenAIStyleImageResponse(
  payload: Record<string, unknown>,
  mimeType = 'image/png',
): Promise<GeneratedImageBuffer[]> {
  const base64Images = findBase64Images(payload);
  const revisedPrompt = readRevisedPrompt(payload);
  if (base64Images.length > 0) {
    return base64Images.map((b64) => ({
      buffer: decodeGeneratedImageBase64(b64),
      mimeType,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    }));
  }

  const data = Array.isArray(payload.data) ? payload.data : [];
  const urlImages: GeneratedImageBuffer[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const url = readStringValue(entry.url);
    if (!url) continue;
    urlImages.push({
      buffer: await fetchProviderImageUrl(url),
      mimeType,
      ...(typeof entry.revised_prompt === 'string'
        ? { revisedPrompt: entry.revised_prompt }
        : {}),
      metadata: { source_url: url },
    });
  }
  if (urlImages.length > 0) return urlImages;
  throw new Error('provider response did not include generated image data');
}

function buildImageInputContent(request: NormalizedImageGenerationRequest) {
  return [
    { type: 'input_text', text: request.prompt },
    ...request.references.map((ref) => ({
      type: 'input_image',
      image_url: `data:${ref.mimeType};base64,${ref.buffer.toString('base64')}`,
    })),
  ];
}

async function generateWithOpenAIResponses(
  candidate: ProviderCandidate,
  request: NormalizedImageGenerationRequest,
): Promise<GeneratedImageBuffer[]> {
  const tool: Record<string, unknown> = { type: 'image_generation' };
  if (request.size) tool.size = request.size;
  if (request.quality) tool.quality = request.quality;
  const payload = await fetchJson(`${candidate.baseUrl}/responses`, {
    method: 'POST',
    headers: authJsonHeaders(candidate),
    body: JSON.stringify({
      model: candidate.model,
      input: [{ role: 'user', content: buildImageInputContent(request) }],
      tools: [tool],
    }),
  });
  return parseOpenAIStyleImageResponse(payload);
}

async function generateWithOpenAIImages(
  candidate: ProviderCandidate,
  request: NormalizedImageGenerationRequest,
): Promise<GeneratedImageBuffer[]> {
  const body: Record<string, unknown> = {
    model: candidate.model,
    prompt: request.prompt,
    n: request.count,
  };
  if (request.size) body.size = request.size;
  if (request.quality) body.quality = request.quality;
  const payload = await fetchJson(`${candidate.baseUrl}/images/generations`, {
    method: 'POST',
    headers: authJsonHeaders(candidate),
    body: JSON.stringify(body),
  });
  return parseOpenAIStyleImageResponse(payload);
}

async function generateWithXai(
  candidate: ProviderCandidate,
  request: NormalizedImageGenerationRequest,
): Promise<GeneratedImageBuffer[]> {
  const body: Record<string, unknown> = {
    model: candidate.model,
    prompt: request.prompt,
    n: request.count,
  };
  if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
  if (request.size) body.resolution = request.size.toLowerCase();
  const payload = await fetchJson(`${candidate.baseUrl}/images/generations`, {
    method: 'POST',
    headers: authJsonHeaders(candidate),
    body: JSON.stringify(body),
  });
  return parseOpenAIStyleImageResponse(payload);
}

async function generateWithGemini(
  candidate: ProviderCandidate,
  request: NormalizedImageGenerationRequest,
): Promise<GeneratedImageBuffer[]> {
  const baseUrl = candidate.baseUrl.replace(/\/openai$/i, '');
  const endpoint = `${baseUrl}/models/${encodeURIComponent(candidate.model)}:generateContent?key=${encodeURIComponent(candidate.apiKey)}`;
  const parts: Record<string, unknown>[] = [{ text: request.prompt }];
  for (const ref of request.references) {
    parts.push({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.buffer.toString('base64'),
      },
    });
  }
  const payload = await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(candidate.requestHeaders || {}),
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
  });

  const images: GeneratedImageBuffer[] = [];
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];
  for (const item of candidates) {
    if (!isRecord(item) || !isRecord(item.content)) continue;
    const parts = Array.isArray(item.content.parts) ? item.content.parts : [];
    for (const part of parts) {
      if (!isRecord(part) || !isRecord(part.inlineData)) continue;
      const data = readStringValue(part.inlineData.data);
      const mimeType = readStringValue(part.inlineData.mimeType) || 'image/png';
      if (!data) continue;
      images.push({ buffer: decodeGeneratedImageBase64(data), mimeType });
    }
  }
  if (images.length > 0) return images;
  throw new Error('Gemini response did not include generated image data');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sizeToBflDimensions(size: string | null): {
  width?: number;
  height?: number;
} {
  const match = String(size || '').match(/^(\d+)x(\d+)$/i);
  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return {};
  return { width, height };
}

async function fetchBflJson(
  url: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  return fetchJson(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-key': apiKey,
      ...((init.headers as Record<string, string> | undefined) || {}),
    },
  });
}

async function pollBflImageResult(
  pollingUrl: string,
  apiKey: string,
): Promise<string> {
  const deadline = Date.now() + BFL_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await fetchBflJson(pollingUrl, apiKey, { method: 'GET' });
    const status = readStringValue(payload.status)?.toLowerCase() || '';
    if (status === 'ready') {
      const result = isRecord(payload.result) ? payload.result : null;
      const sampleUrl = result ? readStringValue(result.sample) : null;
      if (!sampleUrl)
        throw new Error('BFL response did not include a sample URL');
      return sampleUrl;
    }
    if (status === 'error' || status === 'failed') {
      throw new Error(`BFL generation failed: ${JSON.stringify(payload)}`);
    }
    await sleep(BFL_POLL_INTERVAL_MS);
  }
  throw new Error(`BFL generation timed out after ${BFL_POLL_TIMEOUT_MS}ms`);
}

async function generateWithBfl(
  candidate: ProviderCandidate,
  request: NormalizedImageGenerationRequest,
): Promise<GeneratedImageBuffer[]> {
  const body: Record<string, unknown> = {
    prompt: request.prompt,
    output_format: 'png',
    ...sizeToBflDimensions(request.size),
  };
  request.references.slice(0, 8).forEach((ref, index) => {
    const key = index === 0 ? 'input_image' : `input_image_${index + 1}`;
    body[key] = `data:${ref.mimeType};base64,${ref.buffer.toString('base64')}`;
  });
  const start = await fetchBflJson(
    `${candidate.baseUrl}/${candidate.model}`,
    candidate.apiKey,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  const pollingUrl = readStringValue(start.polling_url);
  if (!pollingUrl)
    throw new Error('BFL response did not include a polling URL');
  const sampleUrl = await pollBflImageResult(pollingUrl, candidate.apiKey);
  return [
    {
      buffer: await fetchProviderImageUrl(sampleUrl),
      mimeType: 'image/png',
      metadata: {
        request_id: readStringValue(start.id) || undefined,
        source_url: sampleUrl,
      },
    },
  ];
}

async function generateWithCandidate(
  candidate: ProviderCandidate,
  request: NormalizedImageGenerationRequest,
): Promise<GeneratedImageBuffer[]> {
  if (candidate.id === 'bfl') return generateWithBfl(candidate, request);
  if (candidate.id === 'gemini') return generateWithGemini(candidate, request);
  if (candidate.id === 'xai') return generateWithXai(candidate, request);
  if (candidate.id === 'openai' && request.references.length > 0) {
    return generateWithOpenAIResponses(candidate, request);
  }
  return generateWithOpenAIImages(candidate, request);
}

function persistImages(
  images: GeneratedImageBuffer[],
  provider: ProviderCandidate,
): Array<Record<string, unknown>> {
  validateGeneratedImageSizes(images);
  const outputRoot = path.join(WORKSPACE_ROOT, OUTPUT_DIR);
  fs.mkdirSync(outputRoot, { recursive: true });
  return images.map((image, index) => {
    const ext = extensionFromMimeType(image.mimeType);
    const filename = `image-${Date.now()}-${index + 1}-${randomUUID().slice(0, 8)}${ext}`;
    const hostPath = path.join(outputRoot, filename);
    fs.writeFileSync(hostPath, image.buffer);
    const displayPath = `${WORKSPACE_ROOT_DISPLAY}/${OUTPUT_DIR}/${filename}`;
    return {
      path: displayPath,
      filename,
      mimeType: image.mimeType,
      sizeBytes: image.buffer.length,
      provider: provider.id,
      model: provider.model,
      ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      ...(image.metadata ? { metadata: image.metadata } : {}),
    };
  });
}

function validateGeneratedImageSizes(images: GeneratedImageBuffer[]): void {
  let totalBytes = 0;
  for (const image of images) {
    assertGeneratedImageSize(image.buffer);
    totalBytes += image.buffer.length;
    if (totalBytes > MAX_GENERATED_TOTAL_BYTES) {
      throw new Error(
        `generated images exceed max total size (${MAX_GENERATED_TOTAL_BYTES} bytes)`,
      );
    }
  }
}

function sanitizeProviderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runImageGenerate(
  args: Record<string, unknown>,
  context: ImageGenerationRuntimeContext,
): Promise<string> {
  const action = readStringValue(args.action)?.toLowerCase();
  if (action === 'list') {
    return JSON.stringify(listImageGenerationProviders(context), null, 2);
  }

  const request = await normalizeRequest(args, context);
  const candidates = buildProviderCandidates(context);
  if (candidates.length === 0) {
    throw new Error(
      'image_generate is not configured: set OPENAI_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, XAI_API_KEY, BFL_API_KEY/BLACK_FOREST_LABS_API_KEY, or use a configured openai-codex/gemini/xai model.',
    );
  }

  const attempts: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const providerWarnings = [...request.warnings];
      if (candidate.id === 'xai' && request.quality) {
        providerWarnings.push(
          'xAI does not support quality; quality was ignored.',
        );
      }
      if (candidate.id === 'gemini') {
        if (request.size)
          providerWarnings.push(
            'Gemini does not support size; size was ignored.',
          );
        if (request.quality) {
          providerWarnings.push(
            'Gemini does not support quality; quality was ignored.',
          );
        }
        if (request.count > 1) {
          providerWarnings.push(
            'Gemini returns provider-defined image counts; count was not enforced.',
          );
        }
      }
      if (candidate.id === 'bfl') {
        if (request.quality) {
          providerWarnings.push(
            'BFL does not support quality; quality was ignored.',
          );
        }
        if (request.count > 1) {
          providerWarnings.push(
            'BFL returns one image per request; count was not enforced.',
          );
        }
      }

      const images = await generateWithCandidate(candidate, request);
      const persisted = persistImages(
        images.slice(0, request.count),
        candidate,
      );
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
          images: persisted,
          artifacts: persisted.map((image) => ({
            path: image.path,
            filename: image.filename,
            mimeType: image.mimeType,
          })),
          warnings: providerWarnings,
          attempts,
          reference_count: request.references.length,
          aspect_ratio: request.aspectRatio,
        },
        null,
        2,
      );
    } catch (error) {
      const detail = sanitizeProviderError(error);
      errors.push(`${candidate.id}: ${detail}`);
      attempts.push({
        provider: candidate.id,
        model: candidate.model,
        success: false,
        error: detail,
      });
    }
  }

  throw new Error(
    `all image generation providers failed: ${errors.join(' | ')}`,
  );
}
