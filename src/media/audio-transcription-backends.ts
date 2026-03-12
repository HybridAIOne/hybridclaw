import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  RuntimeAudioCliModelConfig,
  RuntimeAudioProviderModelConfig,
  RuntimeAudioTranscriptionModelConfig,
  RuntimeAudioTranscriptionProvider,
  RuntimeMediaAudioConfig,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';

const ABSOLUTE_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const CLI_OUTPUT_MAX_BUFFER = 5 * 1024 * 1024;
const GEMINI_CLI_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
const DEFAULT_GOOGLE_MODEL = 'gemini-3-flash-preview';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_DEEPGRAM_BASE_URL = 'https://api.deepgram.com/v1';
const DEFAULT_GOOGLE_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';

const binaryCache = new Map<string, Promise<string | null>>();
const geminiProbeCache = new Map<string, Promise<boolean>>();

const COMMON_WHISPER_CPP_MODEL_PATHS = [
  '/opt/homebrew/share/whisper-cpp/ggml-tiny.bin',
  '/opt/homebrew/share/whisper-cpp/ggml-base.bin',
  '/opt/homebrew/share/whisper-cpp/ggml-small.bin',
  '/opt/homebrew/share/whisper-cpp/ggml-tiny.en.bin',
  '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin',
  '/opt/homebrew/share/whisper-cpp/ggml-small.en.bin',
  '/opt/homebrew/share/whisper.cpp/ggml-tiny.bin',
  '/opt/homebrew/share/whisper.cpp/ggml-base.bin',
  '/opt/homebrew/share/whisper.cpp/ggml-small.bin',
  '/opt/homebrew/share/whisper.cpp/ggml-tiny.en.bin',
  '/opt/homebrew/share/whisper.cpp/ggml-base.en.bin',
  '/opt/homebrew/share/whisper.cpp/ggml-small.en.bin',
  '/usr/local/share/whisper-cpp/ggml-tiny.bin',
  '/usr/local/share/whisper-cpp/ggml-base.bin',
  '/usr/local/share/whisper-cpp/ggml-small.bin',
  '/usr/local/share/whisper.cpp/ggml-tiny.bin',
  '/usr/local/share/whisper.cpp/ggml-base.bin',
  '/usr/local/share/whisper.cpp/ggml-small.bin',
] as const;

export interface AudioTranscriptionResult {
  text: string;
  backend: string;
}

function normalizeMimeType(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().split(';')[0]?.trim();
  return normalized || null;
}

function normalizeBaseUrl(
  baseUrl: string | undefined,
  fallback: string,
): string {
  const raw = (baseUrl || '').trim() || fallback;
  return raw.replace(/\/+$/, '');
}

function composeAbortSignal(
  timeoutMs: number,
  abortSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!abortSignal) return timeoutSignal;
  return AbortSignal.any([abortSignal, timeoutSignal]);
}

function expandHomeDir(value: string): string {
  if (!value.startsWith('~')) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.resolve(expandHomeDir(filePath)));
    return stat.isFile();
  } catch {
    return false;
  }
}

function resolveLookupCommand(): string {
  return process.platform === 'win32' ? 'where' : 'which';
}

async function findBinary(name: string): Promise<string | null> {
  const cached = binaryCache.get(name);
  if (cached) return cached;

  const resolved = (async () => {
    const lookup = spawnSync(resolveLookupCommand(), [name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (lookup.status === 0 && !lookup.error) {
      const first = (lookup.stdout || '')
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find(Boolean);
      if (first) return path.resolve(expandHomeDir(first));
    }

    const direct = spawnSync(name, ['--version'], {
      stdio: 'ignore',
    });
    if (!direct.error) return name;
    return null;
  })();

  binaryCache.set(name, resolved);
  return resolved;
}

async function hasBinary(name: string): Promise<boolean> {
  return Boolean(await findBinary(name));
}

function extractLastJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const start = trimmed.lastIndexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}

function extractGeminiResponse(raw: string): string | null {
  const payload = extractLastJsonObject(raw);
  if (!payload || typeof payload !== 'object') return null;
  const response = (payload as { response?: unknown }).response;
  if (typeof response !== 'string') return null;
  const normalized = response.trim();
  return normalized || null;
}

function extractTextFromStructuredOutput(raw: string): string | null {
  const gemini = extractGeminiResponse(raw);
  if (gemini) return gemini;

  const payload = extractLastJsonObject(raw);
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  for (const key of ['text', 'transcript', 'output_text']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const response = record.response;
  if (typeof response === 'string' && response.trim()) {
    return response.trim();
  }

  return null;
}

function sanitizeOutputBaseName(fileName: string): string {
  const baseName = path.basename(fileName, path.extname(fileName));
  const normalized = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').trim();
  return normalized || 'audio';
}

function buildProviderBackendLabel(
  provider: RuntimeAudioTranscriptionProvider,
  model: string,
): string {
  return `${provider}/${model}`;
}

function readProviderApiKey(
  provider: RuntimeAudioTranscriptionProvider,
): string | null {
  if (provider === 'openai') {
    return String(process.env.OPENAI_API_KEY || '').trim() || null;
  }
  if (provider === 'groq') {
    return String(process.env.GROQ_API_KEY || '').trim() || null;
  }
  if (provider === 'deepgram') {
    return String(process.env.DEEPGRAM_API_KEY || '').trim() || null;
  }
  const gemini = String(process.env.GEMINI_API_KEY || '').trim();
  if (gemini) return gemini;
  const google = String(process.env.GOOGLE_API_KEY || '').trim();
  return google || null;
}

function resolveProviderModel(entry: RuntimeAudioProviderModelConfig): string {
  const configured = (entry.model || '').trim();
  if (configured) return configured;
  if (entry.provider === 'openai') return DEFAULT_OPENAI_MODEL;
  if (entry.provider === 'groq') return DEFAULT_GROQ_MODEL;
  if (entry.provider === 'deepgram') return DEFAULT_DEEPGRAM_MODEL;
  return DEFAULT_GOOGLE_MODEL;
}

function resolveProviderBaseUrl(
  entry: RuntimeAudioProviderModelConfig,
): string {
  if (entry.provider === 'openai') {
    return normalizeBaseUrl(entry.baseUrl, DEFAULT_OPENAI_BASE_URL);
  }
  if (entry.provider === 'groq') {
    return normalizeBaseUrl(entry.baseUrl, DEFAULT_GROQ_BASE_URL);
  }
  if (entry.provider === 'deepgram') {
    return normalizeBaseUrl(entry.baseUrl, DEFAULT_DEEPGRAM_BASE_URL);
  }
  return normalizeBaseUrl(entry.baseUrl, DEFAULT_GOOGLE_BASE_URL);
}

function resolveEntryTimeoutMs(
  entry: RuntimeAudioTranscriptionModelConfig,
  config: RuntimeMediaAudioConfig,
): number {
  return entry.timeoutMs ?? config.timeoutMs;
}

function resolveEntryMaxBytes(
  entry: RuntimeAudioTranscriptionModelConfig,
  config: RuntimeMediaAudioConfig,
): number {
  return Math.min(entry.maxBytes ?? config.maxBytes, ABSOLUTE_MAX_AUDIO_BYTES);
}

function resolveEntryPrompt(
  entry: RuntimeAudioTranscriptionModelConfig,
  config: RuntimeMediaAudioConfig,
): string {
  return (entry.prompt || '').trim() || config.prompt;
}

function resolveEntryLanguage(
  entry: RuntimeAudioProviderModelConfig,
  config: RuntimeMediaAudioConfig,
): string {
  return (entry.language || '').trim() || config.language;
}

async function resolveWhisperCppModelPath(): Promise<string | null> {
  const explicit = String(process.env.WHISPER_CPP_MODEL || '').trim();
  if (explicit && (await fileExists(explicit))) {
    return path.resolve(expandHomeDir(explicit));
  }
  for (const candidate of COMMON_WHISPER_CPP_MODEL_PATHS) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveSherpaEntry(): Promise<RuntimeAudioCliModelConfig | null> {
  if (!(await hasBinary('sherpa-onnx-offline'))) return null;
  const modelDir = String(process.env.SHERPA_ONNX_MODEL_DIR || '').trim();
  if (!modelDir) return null;

  const tokens = path.join(modelDir, 'tokens.txt');
  const encoder = path.join(modelDir, 'encoder.onnx');
  const decoder = path.join(modelDir, 'decoder.onnx');
  const joiner = path.join(modelDir, 'joiner.onnx');
  if (
    !(await fileExists(tokens)) ||
    !(await fileExists(encoder)) ||
    !(await fileExists(decoder)) ||
    !(await fileExists(joiner))
  ) {
    return null;
  }

  return {
    type: 'cli',
    command: 'sherpa-onnx-offline',
    args: [
      `--tokens=${tokens}`,
      `--encoder=${encoder}`,
      `--decoder=${decoder}`,
      `--joiner=${joiner}`,
      '{{MediaPath}}',
    ],
  };
}

async function resolveWhisperCppEntry(): Promise<RuntimeAudioCliModelConfig | null> {
  if (!(await hasBinary('whisper-cli'))) return null;
  const modelPath = await resolveWhisperCppModelPath();
  if (!modelPath) return null;
  return {
    type: 'cli',
    command: 'whisper-cli',
    args: [
      '-m',
      modelPath,
      '-otxt',
      '-of',
      '{{OutputBase}}',
      '-np',
      '-nt',
      '{{MediaPath}}',
    ],
  };
}

async function resolveWhisperEntry(): Promise<RuntimeAudioCliModelConfig | null> {
  if (!(await hasBinary('whisper'))) return null;
  return {
    type: 'cli',
    command: 'whisper',
    args: [
      '--model',
      'turbo',
      '--output_format',
      'txt',
      '--output_dir',
      '{{OutputDir}}',
      '--verbose',
      'False',
      '{{MediaPath}}',
    ],
  };
}

async function probeGeminiCli(): Promise<boolean> {
  const cached = geminiProbeCache.get('gemini');
  if (cached) return cached;

  const resolved = (async () => {
    if (!(await hasBinary('gemini'))) return false;
    try {
      const result = await runCommand({
        command: 'gemini',
        args: ['--output-format', 'json', 'ok'],
        timeoutMs: GEMINI_CLI_PROBE_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return false;
      return Boolean(
        extractGeminiResponse(result.stdout) ||
          result.stdout.toLowerCase().includes('ok'),
      );
    } catch {
      return false;
    }
  })();

  geminiProbeCache.set('gemini', resolved);
  return resolved;
}

async function resolveGeminiCliEntry(): Promise<RuntimeAudioCliModelConfig | null> {
  if (!(await probeGeminiCli())) return null;
  return {
    type: 'cli',
    command: 'gemini',
    args: [
      '--output-format',
      'json',
      '--allowed-tools',
      'read_many_files',
      '--include-directories',
      '{{MediaDir}}',
      '{{Prompt}}',
      'Use read_many_files to read {{MediaPath}} and respond with only the text output.',
    ],
  };
}

function resolveAutoProviderEntries(): RuntimeAudioProviderModelConfig[] {
  const entries: RuntimeAudioProviderModelConfig[] = [];
  if (readProviderApiKey('openai')) {
    entries.push({ type: 'provider', provider: 'openai' });
  }
  if (readProviderApiKey('groq')) {
    entries.push({ type: 'provider', provider: 'groq' });
  }
  if (readProviderApiKey('deepgram')) {
    entries.push({ type: 'provider', provider: 'deepgram' });
  }
  if (readProviderApiKey('google')) {
    entries.push({ type: 'provider', provider: 'google' });
  }
  return entries;
}

export async function resolveAudioTranscriptionModels(
  config: RuntimeMediaAudioConfig,
): Promise<RuntimeAudioTranscriptionModelConfig[]> {
  if (config.models.length > 0) {
    return [...config.models];
  }

  const entries: RuntimeAudioTranscriptionModelConfig[] = [];
  const sherpa = await resolveSherpaEntry();
  if (sherpa) entries.push(sherpa);
  const whisperCpp = await resolveWhisperCppEntry();
  if (whisperCpp) entries.push(whisperCpp);
  const whisper = await resolveWhisperEntry();
  if (whisper) entries.push(whisper);
  const geminiCli = await resolveGeminiCliEntry();
  if (geminiCli) entries.push(geminiCli);
  entries.push(...resolveAutoProviderEntries());
  return entries;
}

function createGoogleAuthHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { token?: unknown };
      if (typeof parsed.token === 'string' && parsed.token.trim()) {
        return {
          Authorization: `Bearer ${parsed.token.trim()}`,
          'Content-Type': 'application/json',
        };
      }
    } catch {
      // Fall through to API-key mode.
    }
  }
  return {
    'x-goog-api-key': trimmed,
    'Content-Type': 'application/json',
  };
}

async function readResponseError(response: Response): Promise<string> {
  const contentType = String(response.headers.get('content-type') || '');
  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const direct = payload?.error;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    if (direct && typeof direct === 'object') {
      const message = (direct as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
    const message = payload?.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  const text = await response.text().catch(() => '');
  return text.trim() || `HTTP ${response.status}`;
}

async function transcribeOpenAiCompatibleAudio(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string | null;
  prompt: string;
  language: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
}): Promise<string> {
  const form = new FormData();
  form.set('model', params.model);
  form.set(
    'file',
    new Blob([new Uint8Array(params.fileBuffer)], {
      type: params.mimeType || 'application/octet-stream',
    }),
    params.fileName,
  );
  form.set('response_format', 'json');
  if (params.prompt.trim()) {
    form.set('prompt', params.prompt.trim());
  }
  if (params.language.trim()) {
    form.set('language', params.language.trim());
  }

  const headers = new Headers(params.headers);
  if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${params.apiKey}`);
  }

  const response = await fetch(`${params.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: composeAbortSignal(params.timeoutMs, params.abortSignal),
  });
  if (!response.ok) {
    throw new Error(await readResponseError(response));
  }

  const contentType = String(response.headers.get('content-type') || '');
  if (contentType.includes('application/json')) {
    const payload = (await response.json()) as { text?: unknown };
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      throw new Error('Audio transcription response missing text');
    }
    return text;
  }

  const text = (await response.text()).trim();
  if (!text) {
    throw new Error('Audio transcription response missing text');
  }
  return text;
}

async function transcribeDeepgramAudio(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fileBuffer: Buffer;
  mimeType: string | null;
  language: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): Promise<string> {
  const url = new URL(`${params.baseUrl}/listen`);
  url.searchParams.set('model', params.model);
  if (params.language.trim()) {
    url.searchParams.set('language', params.language.trim());
  }
  for (const [key, value] of Object.entries(params.query || {})) {
    if (!value.trim()) continue;
    url.searchParams.set(key, value);
  }

  const headers = new Headers(params.headers);
  if (!headers.has('authorization')) {
    headers.set('authorization', `Token ${params.apiKey}`);
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', params.mimeType || 'application/octet-stream');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: new Uint8Array(params.fileBuffer),
    signal: composeAbortSignal(params.timeoutMs, params.abortSignal),
  });
  if (!response.ok) {
    throw new Error(await readResponseError(response));
  }

  const payload = (await response.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string }>;
      }>;
    };
  };
  const text =
    payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
  if (!text) {
    throw new Error('Audio transcription response missing transcript');
  }
  return text;
}

async function transcribeGoogleAudio(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fileBuffer: Buffer;
  mimeType: string | null;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
}): Promise<string> {
  const headers = new Headers(params.headers);
  for (const [key, value] of Object.entries(
    createGoogleAuthHeaders(params.apiKey),
  )) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  const response = await fetch(
    `${params.baseUrl}/models/${params.model}:generateContent`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: params.prompt.trim() || 'Transcribe the audio.' },
              {
                inline_data: {
                  mime_type: params.mimeType || 'audio/wav',
                  data: params.fileBuffer.toString('base64'),
                },
              },
            ],
          },
        ],
      }),
      signal: composeAbortSignal(params.timeoutMs, params.abortSignal),
    },
  );
  if (!response.ok) {
    throw new Error(await readResponseError(response));
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const text = (payload.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text?.trim())
    .filter(Boolean)
    .join('\n');
  if (!text) {
    throw new Error('Audio transcription response missing text');
  }
  return text;
}

function buildCliSubstitutions(params: {
  mediaPath: string;
  outputDir: string;
  outputBase: string;
  prompt: string;
}): Record<string, string> {
  return {
    '{{MediaPath}}': params.mediaPath,
    '{{MediaDir}}': path.dirname(params.mediaPath),
    '{{OutputDir}}': params.outputDir,
    '{{OutputBase}}': params.outputBase,
    '{{Prompt}}': params.prompt,
  };
}

function applyCliSubstitutions(
  value: string,
  substitutions: Record<string, string>,
): string {
  let next = value;
  for (const [token, replacement] of Object.entries(substitutions)) {
    next = next.split(token).join(replacement);
  }
  return next;
}

async function readCliTranscript(
  outputBase: string,
  fileName: string,
  stdout: string,
): Promise<string | null> {
  const outputBaseFile = `${outputBase}.txt`;
  if (await fileExists(outputBaseFile)) {
    const text = (await fs.readFile(outputBaseFile, 'utf-8')).trim();
    if (text) return text;
  }

  const outputDirFile = path.join(
    path.dirname(outputBase),
    `${sanitizeOutputBaseName(fileName)}.txt`,
  );
  if (await fileExists(outputDirFile)) {
    const text = (await fs.readFile(outputDirFile, 'utf-8')).trim();
    if (text) return text;
  }

  const structured = extractTextFromStructuredOutput(stdout);
  if (structured) return structured;

  const trimmed = stdout.trim();
  return trimmed || null;
}

function createCommandError(params: {
  command: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}): Error {
  const detail = (params.stderr || params.stdout).trim();
  if (params.timedOut) {
    return new Error(`"${params.command}" timed out`);
  }
  if (detail) {
    return new Error(
      `"${params.command}" exited with code ${params.exitCode ?? 1}: ${detail}`,
    );
  }
  return new Error(
    `"${params.command}" exited with code ${params.exitCode ?? 1}`,
  );
}

async function runCommand(params: {
  command: string;
  args: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const appendChunk = (
      target: 'stdout' | 'stderr',
      chunk: Buffer | string,
    ): void => {
      const text = chunk.toString();
      if (target === 'stdout') {
        if (stdout.length < CLI_OUTPUT_MAX_BUFFER) {
          stdout += text.slice(0, CLI_OUTPUT_MAX_BUFFER - stdout.length);
        }
        return;
      }
      if (stderr.length < CLI_OUTPUT_MAX_BUFFER) {
        stderr += text.slice(0, CLI_OUTPUT_MAX_BUFFER - stderr.length);
      }
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (params.abortSignal && abortListener) {
        params.abortSignal.removeEventListener('abort', abortListener);
      }
    };

    const abortListener = (): void => {
      child.kill('SIGTERM');
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, params.timeoutMs);

    if (params.abortSignal) {
      if (params.abortSignal.aborted) {
        clearTimeout(timeout);
        child.kill('SIGTERM');
      } else {
        params.abortSignal.addEventListener('abort', abortListener, {
          once: true,
        });
      }
    }

    child.stdout?.on('data', (chunk) => appendChunk('stdout', chunk));
    child.stderr?.on('data', (chunk) => appendChunk('stderr', chunk));
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (exitCode) => {
      cleanup();
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

async function transcribeWithCli(params: {
  entry: RuntimeAudioCliModelConfig;
  config: RuntimeMediaAudioConfig;
  filePath: string;
  fileName: string;
  abortSignal?: AbortSignal;
}): Promise<AudioTranscriptionResult> {
  const prompt = resolveEntryPrompt(params.entry, params.config);
  const timeoutMs = resolveEntryTimeoutMs(params.entry, params.config);
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hybridclaw-audio-cli-'),
  );
  const outputBase = path.join(
    outputDir,
    sanitizeOutputBaseName(params.fileName),
  );
  const substitutions = buildCliSubstitutions({
    mediaPath: params.filePath,
    outputDir,
    outputBase,
    prompt,
  });

  const command = applyCliSubstitutions(params.entry.command, substitutions);
  const args = params.entry.args.map((arg) =>
    applyCliSubstitutions(arg, substitutions),
  );

  try {
    const result = await runCommand({
      command,
      args,
      timeoutMs,
      abortSignal: params.abortSignal,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      throw createCommandError({
        command,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
      });
    }

    const text = await readCliTranscript(
      outputBase,
      params.fileName,
      result.stdout,
    );
    if (!text) {
      throw new Error(`"${command}" produced no transcript`);
    }

    return {
      text,
      backend: `cli:${path.basename(command)}`,
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeWithProvider(params: {
  entry: RuntimeAudioProviderModelConfig;
  config: RuntimeMediaAudioConfig;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string | null;
  abortSignal?: AbortSignal;
}): Promise<AudioTranscriptionResult> {
  const apiKey = readProviderApiKey(params.entry.provider);
  if (!apiKey) {
    throw new Error(`Missing API key for ${params.entry.provider}`);
  }

  const model = resolveProviderModel(params.entry);
  const baseUrl = resolveProviderBaseUrl(params.entry);
  const prompt = resolveEntryPrompt(params.entry, params.config);
  const language = resolveEntryLanguage(params.entry, params.config);
  const timeoutMs = resolveEntryTimeoutMs(params.entry, params.config);

  let text: string;
  if (params.entry.provider === 'openai' || params.entry.provider === 'groq') {
    text = await transcribeOpenAiCompatibleAudio({
      baseUrl,
      apiKey,
      model,
      fileBuffer: params.fileBuffer,
      fileName: params.fileName,
      mimeType: params.mimeType,
      prompt,
      language,
      timeoutMs,
      abortSignal: params.abortSignal,
      headers: params.entry.headers,
    });
  } else if (params.entry.provider === 'deepgram') {
    text = await transcribeDeepgramAudio({
      baseUrl,
      apiKey,
      model,
      fileBuffer: params.fileBuffer,
      mimeType: params.mimeType,
      language,
      timeoutMs,
      abortSignal: params.abortSignal,
      headers: params.entry.headers,
      query: params.entry.query,
    });
  } else {
    text = await transcribeGoogleAudio({
      baseUrl,
      apiKey,
      model,
      fileBuffer: params.fileBuffer,
      mimeType: params.mimeType,
      prompt,
      timeoutMs,
      abortSignal: params.abortSignal,
      headers: params.entry.headers,
    });
  }

  return {
    text,
    backend: buildProviderBackendLabel(params.entry.provider, model),
  };
}

export async function transcribeAudioWithFallback(params: {
  filePath: string;
  fileName: string;
  mimeType: string | null;
  config: RuntimeMediaAudioConfig;
  models?: RuntimeAudioTranscriptionModelConfig[];
  abortSignal?: AbortSignal;
}): Promise<AudioTranscriptionResult | null> {
  const models =
    params.models ?? (await resolveAudioTranscriptionModels(params.config));
  if (models.length === 0) return null;

  const stat = await fs.stat(params.filePath);
  if (!stat.isFile()) return null;

  let fileBuffer: Buffer | null = null;

  for (const entry of models) {
    if (params.abortSignal?.aborted) break;
    const maxBytes = resolveEntryMaxBytes(entry, params.config);
    if (stat.size > maxBytes) {
      continue;
    }

    try {
      if (entry.type === 'cli') {
        return await transcribeWithCli({
          entry,
          config: params.config,
          filePath: params.filePath,
          fileName: params.fileName,
          abortSignal: params.abortSignal,
        });
      }

      fileBuffer ??= await fs.readFile(params.filePath);
      return await transcribeWithProvider({
        entry,
        config: params.config,
        fileBuffer,
        fileName: params.fileName,
        mimeType: normalizeMimeType(params.mimeType),
        abortSignal: params.abortSignal,
      });
    } catch (error) {
      logger.warn(
        {
          error,
          backend: entry.type === 'cli' ? entry.command : entry.provider,
          fileName: params.fileName,
          filePath: params.filePath,
        },
        'Audio transcription backend failed; trying next backend',
      );
    }
  }

  return null;
}

export function clearAudioTranscriptionCachesForTests(): void {
  binaryCache.clear();
  geminiProbeCache.clear();
}
