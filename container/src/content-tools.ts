import fs from 'node:fs';
import path from 'node:path';
import {
  callRoutedModel,
  extractResponseTextContent,
  type RoutedModelContext,
} from './providers/router.js';
import {
  resolveMediaPath,
  resolveWorkspacePath,
  stripWorkspaceRootPrefix,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';
import type {
  ChatMessage,
  ContentToolConfig,
  MediaContextItem,
} from './types.js';

const GENERATED_CONTENT_DIR = '.generated-content';
const GENERATED_IMAGE_DIR = path.join(
  WORKSPACE_ROOT,
  GENERATED_CONTENT_DIR,
  'images',
);
const GENERATED_AUDIO_DIR = path.join(
  WORKSPACE_ROOT,
  GENERATED_CONTENT_DIR,
  'audio',
);
const GENERATED_DIAGRAM_DIR = path.join(
  WORKSPACE_ROOT,
  GENERATED_CONTENT_DIR,
  'diagrams',
);

type SupportedAspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
type SupportedResolution = '1K' | '2K' | '4K';
type SupportedSpeechFormat = 'mp3' | 'wav' | 'opus';

export interface DiagramToolContext extends RoutedModelContext {
  maxTokens?: number;
}

function readStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function readNumberArg(
  args: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function ensureConfiguredApiKey(apiKey: string, envName: string): string {
  const normalized = apiKey.trim();
  if (normalized) return normalized;
  throw new Error(
    `${envName} is not configured. Store it in runtime secrets or export it before using this tool.`,
  );
}

function sanitizeFileStem(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'asset';
}

function buildDefaultStem(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDisplayPath(filePath: string): string {
  const relative = stripWorkspaceRootPrefix(filePath);
  return relative
    ? `${WORKSPACE_ROOT_DISPLAY}/${relative}`
    : WORKSPACE_ROOT_DISPLAY;
}

function ensureDirForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveSingleOutputPath(params: {
  requestedOutputPath: string;
  defaultDir: string;
  prefix: string;
  extension: string;
}): string {
  if (params.requestedOutputPath) {
    const resolved = resolveWorkspacePath(params.requestedOutputPath);
    if (!resolved) {
      throw new Error('output_path must stay under /workspace');
    }
    const parsed = path.parse(resolved);
    const fileName = parsed.name || buildDefaultStem(params.prefix);
    return path.join(parsed.dir, `${fileName}.${params.extension}`);
  }

  return path.join(
    params.defaultDir,
    `${buildDefaultStem(params.prefix)}.${params.extension}`,
  );
}

function resolveImageOutputPaths(params: {
  outputDir: string;
  count: number;
  extension: string;
  model: string;
}): string[] {
  let baseDir = GENERATED_IMAGE_DIR;
  if (params.outputDir) {
    const resolved = resolveWorkspacePath(params.outputDir);
    if (!resolved) {
      throw new Error('output_dir must stay under /workspace');
    }
    baseDir = resolved;
  }

  fs.mkdirSync(baseDir, { recursive: true });
  const stem = buildDefaultStem(
    sanitizeFileStem(path.basename(params.model).replace(/\//g, '-')),
  );
  return Array.from({ length: params.count }, (_unused, index) =>
    path.join(baseDir, `${stem}-${index + 1}.${params.extension}`),
  );
}

function inferAudioMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.webm') return 'audio/webm';
  return 'application/octet-stream';
}

function normalizeAudioInputPath(
  rawPath: string,
  mediaContext: MediaContextItem[],
): string {
  const resolved =
    resolveWorkspacePath(rawPath) ||
    resolveMediaPath(rawPath) ||
    resolveWorkspacePath(rawPath.replace(/\\/g, '/'));
  if (!resolved) {
    throw new Error(
      'audio_path must be a local file under /workspace, /discord-media-cache, or /uploaded-media-cache',
    );
  }

  const knownMediaPaths = new Set(
    mediaContext
      .map((entry) => entry.path?.trim() || '')
      .filter(Boolean)
      .map((entryPath) => resolveMediaPath(entryPath))
      .filter((value): value is string => Boolean(value)),
  );
  if (
    knownMediaPaths.size > 0 &&
    !resolveWorkspacePath(resolved) &&
    !knownMediaPaths.has(resolved)
  ) {
    throw new Error(
      'requested audio file is not part of the current media context',
    );
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`audio file not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`audio_path is not a file: ${resolved}`);
  }
  if (stat.size <= 0) {
    throw new Error(`audio file is empty: ${resolved}`);
  }
  return resolved;
}

function mapResolutionToEdge(resolution: SupportedResolution): number {
  if (resolution === '4K') return 4096;
  if (resolution === '2K') return 2048;
  return 1024;
}

function aspectRatioToPreset(aspectRatio: SupportedAspectRatio): string {
  if (aspectRatio === '1:1') return 'square_hd';
  if (aspectRatio === '4:3') return 'landscape_4_3';
  if (aspectRatio === '3:4') return 'portrait_4_3';
  if (aspectRatio === '16:9') return 'landscape_16_9';
  return 'portrait_16_9';
}

function aspectRatioToDimensions(
  aspectRatio: SupportedAspectRatio,
  edge: number,
): { width: number; height: number } {
  const [widthRatioRaw, heightRatioRaw] = aspectRatio.split(':');
  const widthRatio = Number.parseInt(widthRatioRaw, 10);
  const heightRatio = Number.parseInt(heightRatioRaw, 10);
  if (widthRatio >= heightRatio) {
    return {
      width: edge,
      height: Math.max(1, Math.round((edge * heightRatio) / widthRatio)),
    };
  }
  return {
    width: Math.max(1, Math.round((edge * widthRatio) / heightRatio)),
    height: edge,
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/u.exec(trimmed);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }
  return trimmed;
}

async function readResponseError(response: Response): Promise<string> {
  const contentType = String(response.headers.get('content-type') || '');
  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (typeof payload?.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (
      payload?.error &&
      typeof payload.error === 'object' &&
      typeof (payload.error as { message?: unknown }).message === 'string'
    ) {
      return String((payload.error as { message?: unknown }).message).trim();
    }
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  }
  const text = (await response.text().catch(() => '')).trim();
  return text || `HTTP ${response.status}`;
}

async function downloadBinary(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export async function runImageGenerateTool(params: {
  args: Record<string, unknown>;
  config: ContentToolConfig['imageGeneration'];
}): Promise<string> {
  const prompt = readStringArg(params.args, 'prompt');
  if (!prompt) {
    throw new Error('prompt is required');
  }

  const apiKey = ensureConfiguredApiKey(params.config.apiKey, 'FAL_API_KEY');
  const count = Math.max(
    1,
    Math.min(
      4,
      Math.floor(
        readNumberArg(params.args, 'count', 'num_images') ??
          params.config.defaultCount,
      ),
    ),
  );
  const aspectRatio =
    (readStringArg(
      params.args,
      'aspect_ratio',
      'aspectRatio',
    ) as SupportedAspectRatio) || params.config.defaultAspectRatio;
  const resolution =
    (readStringArg(params.args, 'resolution') as SupportedResolution) ||
    params.config.defaultResolution;
  const outputFormat =
    (readStringArg(params.args, 'output_format', 'outputFormat') as
      | 'png'
      | 'jpeg') || params.config.defaultOutputFormat;
  const model =
    readStringArg(params.args, 'model') || params.config.defaultModel;
  const timeoutMs = Math.max(
    10_000,
    Math.min(
      300_000,
      Math.floor(
        readNumberArg(params.args, 'timeout_ms', 'timeoutMs') ??
          params.config.timeoutMs,
      ),
    ),
  );
  const edge = mapResolutionToEdge(resolution);
  const imageSize =
    edge === 1024
      ? aspectRatioToPreset(aspectRatio)
      : aspectRatioToDimensions(aspectRatio, edge);

  const response = await fetch(
    `${params.config.baseUrl.replace(/\/+$/g, '')}/${model.replace(/^\/+/, '')}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        num_images: count,
        output_format: outputFormat,
        image_size: imageSize,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(await readResponseError(response));
  }

  const payload = (await response.json()) as {
    images?: Array<{ url?: string; content_type?: string }>;
  };
  const imageUrls = (payload.images || [])
    .map((image) => String(image.url || '').trim())
    .filter(Boolean);
  if (imageUrls.length === 0) {
    throw new Error('FAL response did not include any images');
  }

  const outputPaths = resolveImageOutputPaths({
    outputDir: readStringArg(params.args, 'output_dir', 'outputDir'),
    count: imageUrls.length,
    extension: outputFormat === 'jpeg' ? 'jpg' : 'png',
    model,
  });

  const savedPaths: string[] = [];
  for (let index = 0; index < imageUrls.length; index += 1) {
    const outputPath = outputPaths[index];
    ensureDirForFile(outputPath);
    const imageBytes = await downloadBinary(imageUrls[index], timeoutMs);
    fs.writeFileSync(outputPath, imageBytes);
    savedPaths.push(outputPath);
  }

  return [
    `Generated ${savedPaths.length} image${savedPaths.length === 1 ? '' : 's'} with ${model}.`,
    ...savedPaths.map((savedPath) => `- ${formatDisplayPath(savedPath)}`),
  ].join('\n');
}

export async function runTextToSpeechTool(params: {
  args: Record<string, unknown>;
  config: ContentToolConfig['speech'];
}): Promise<string> {
  const text = readStringArg(params.args, 'text', 'input');
  if (!text) {
    throw new Error('text is required');
  }

  const apiKey = ensureConfiguredApiKey(params.config.apiKey, 'OPENAI_API_KEY');
  const model =
    readStringArg(params.args, 'model') || params.config.defaultModel;
  const voice =
    readStringArg(params.args, 'voice') || params.config.defaultVoice;
  const outputFormat =
    (readStringArg(
      params.args,
      'output_format',
      'outputFormat',
      'format',
    ) as SupportedSpeechFormat) || params.config.defaultOutputFormat;
  const speed = Math.max(
    0.25,
    Math.min(
      4,
      readNumberArg(params.args, 'speed') ?? params.config.defaultSpeed,
    ),
  );
  const timeoutMs = Math.max(
    5_000,
    Math.min(
      300_000,
      Math.floor(
        readNumberArg(params.args, 'timeout_ms', 'timeoutMs') ??
          params.config.timeoutMs,
      ),
    ),
  );
  const trimmedText = text.trim();
  if (trimmedText.length > params.config.maxChars) {
    throw new Error(
      `text exceeds max length (${params.config.maxChars} characters)`,
    );
  }

  const outputPath = resolveSingleOutputPath({
    requestedOutputPath: readStringArg(
      params.args,
      'output_path',
      'outputPath',
    ),
    defaultDir: GENERATED_AUDIO_DIR,
    prefix: 'tts',
    extension: outputFormat === 'opus' ? 'opus' : outputFormat,
  });
  ensureDirForFile(outputPath);

  const response = await fetch(
    `${params.config.baseUrl.replace(/\/+$/g, '')}/audio/speech`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input: trimmedText,
        response_format: outputFormat,
        speed,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(await readResponseError(response));
  }

  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
  return `Synthesized speech with ${model} to ${formatDisplayPath(outputPath)}.`;
}

export async function runAudioTranscribeTool(params: {
  args: Record<string, unknown>;
  config: ContentToolConfig['transcription'];
  mediaContext: MediaContextItem[];
}): Promise<string> {
  const rawPath = readStringArg(params.args, 'audio_path', 'audioPath', 'path');
  if (!rawPath) {
    throw new Error('audio_path is required');
  }

  const apiKey = ensureConfiguredApiKey(params.config.apiKey, 'OPENAI_API_KEY');
  const audioPath = normalizeAudioInputPath(rawPath, params.mediaContext);
  const stat = fs.statSync(audioPath);
  if (stat.size > params.config.maxBytes) {
    throw new Error(
      `audio file exceeds max size (${params.config.maxBytes} bytes)`,
    );
  }

  const model =
    readStringArg(params.args, 'model') || params.config.defaultModel;
  const language =
    readStringArg(params.args, 'language') || params.config.defaultLanguage;
  const prompt =
    readStringArg(params.args, 'prompt') || params.config.defaultPrompt;
  const timeoutMs = Math.max(
    5_000,
    Math.min(
      300_000,
      Math.floor(
        readNumberArg(params.args, 'timeout_ms', 'timeoutMs') ??
          params.config.timeoutMs,
      ),
    ),
  );
  const maxChars = Math.max(
    256,
    Math.min(
      32_000,
      Math.floor(readNumberArg(params.args, 'max_chars', 'maxChars') ?? 8_000),
    ),
  );

  const form = new FormData();
  form.set('model', model);
  form.set(
    'file',
    new Blob([new Uint8Array(fs.readFileSync(audioPath))], {
      type: inferAudioMimeType(audioPath),
    }),
    path.basename(audioPath),
  );
  if (prompt) {
    form.set('prompt', prompt);
  }
  if (language) {
    form.set('language', language);
  }
  form.set('response_format', 'json');

  const response = await fetch(
    `${params.config.baseUrl.replace(/\/+$/g, '')}/audio/transcriptions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(await readResponseError(response));
  }

  const payload = (await response.json()) as { text?: unknown };
  const transcript =
    typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!transcript) {
    throw new Error('transcription response did not include text');
  }

  const trimmed =
    transcript.length > maxChars
      ? `${transcript.slice(0, maxChars).trimEnd()}…`
      : transcript;
  return [
    `Transcript from ${path.basename(audioPath)} (${model}):`,
    trimmed,
  ].join('\n');
}

export async function runDiagramCreateTool(params: {
  args: Record<string, unknown>;
  modelContext: DiagramToolContext;
}): Promise<string> {
  const prompt = readStringArg(params.args, 'prompt', 'description');
  if (!prompt) {
    throw new Error('prompt is required');
  }

  const format =
    readStringArg(params.args, 'format').toLowerCase() === 'svg'
      ? 'svg'
      : 'mermaid';
  const title = readStringArg(params.args, 'title');
  const outputPath = resolveSingleOutputPath({
    requestedOutputPath: readStringArg(
      params.args,
      'output_path',
      'outputPath',
    ),
    defaultDir: GENERATED_DIAGRAM_DIR,
    prefix: format === 'svg' ? 'diagram-svg' : 'diagram',
    extension: format === 'svg' ? 'svg' : 'mmd',
  });
  ensureDirForFile(outputPath);

  const systemPrompt =
    format === 'svg'
      ? 'Return only standalone SVG markup. Do not use code fences. Include a viewBox and readable text labels. Keep the diagram concise and production-ready.'
      : 'Return only Mermaid source. Do not use code fences. Choose the best Mermaid diagram type for the request, prefer concise labels, and keep the diagram immediately renderable.';
  const userPrompt = title
    ? `Title: ${title}\n\nCreate a ${format} diagram for:\n${prompt}`
    : `Create a ${format} diagram for:\n${prompt}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const response = await callRoutedModel({
    ...params.modelContext,
    enableRag: false,
    messages,
    tools: [],
    maxTokens:
      typeof params.modelContext.maxTokens === 'number' &&
      Number.isFinite(params.modelContext.maxTokens)
        ? Math.min(params.modelContext.maxTokens, 4_096)
        : 4_096,
  });
  const rawContent = extractResponseTextContent(
    response.choices[0]?.message?.content,
  );
  const content = stripCodeFence(rawContent || '');
  if (!content) {
    throw new Error('diagram model returned empty content');
  }
  if (format === 'svg' && !/<svg[\s>]/i.test(content)) {
    throw new Error('diagram model did not return valid SVG markup');
  }

  fs.writeFileSync(outputPath, content, 'utf-8');
  if (format === 'svg') {
    return `Saved SVG diagram to ${formatDisplayPath(outputPath)}.`;
  }
  return `Saved Mermaid diagram to ${formatDisplayPath(outputPath)}.\n\n${content}`;
}
