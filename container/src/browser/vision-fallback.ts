import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { WORKSPACE_ROOT } from '../runtime-paths.js';
import type { TaskModelPolicies } from '../types.js';
import type {
  BrowserScreenshotResult,
  BrowserVisionResult,
} from './types.js';

type BrowserVisionContext = {
  provider:
    | 'hybridai'
    | 'openai-codex'
    | 'openrouter'
    | 'ollama'
    | 'lmstudio'
    | 'vllm';
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  requestHeaders: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
  maxTokens?: number;
};

type AnnotationBox = {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const VISION_ROOT = path.join(WORKSPACE_ROOT, '.browser-artifacts', 'vision');
const VISION_RETENTION_MS = 24 * 60 * 60 * 1000;

function ensureVisionRoot(): string {
  fs.mkdirSync(VISION_ROOT, { recursive: true });
  return VISION_ROOT;
}

function pruneOldArtifacts(): void {
  const root = ensureVisionRoot();
  const threshold = Date.now() - VISION_RETENTION_MS;
  for (const entry of fs.readdirSync(root)) {
    const filePath = path.join(root, entry);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= threshold) continue;
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}

function nextArtifactPath(prefix: string): string {
  const root = ensureVisionRoot();
  const nonce = Math.random().toString(36).slice(2, 10);
  return path.join(root, `${prefix}-${Date.now()}-${nonce}.png`);
}

async function annotateScreenshot(
  imageBuffer: Buffer,
  boxes: AnnotationBox[],
): Promise<Buffer | null> {
  if (boxes.length === 0) return null;
  try {
    const canvas = await import('@napi-rs/canvas');
    const image = await canvas.loadImage(imageBuffer);
    const surface = canvas.createCanvas(image.width, image.height);
    const ctx = surface.getContext('2d');
    ctx.drawImage(image, 0, 0, image.width, image.height);
    ctx.lineWidth = Math.max(2, Math.round(image.width / 300));
    ctx.font = `${Math.max(14, Math.round(image.width / 45))}px sans-serif`;
    for (const box of boxes) {
      ctx.strokeStyle = '#ff6b00';
      ctx.fillStyle = 'rgba(255, 107, 0, 0.14)';
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.fillRect(box.x, box.y, box.width, box.height);
      const labelWidth = Math.max(48, ctx.measureText(box.ref).width + 16);
      const labelHeight = Math.max(24, Math.round(image.height / 24));
      const labelX = Math.max(0, Math.min(image.width - labelWidth, box.x));
      const labelY = Math.max(0, box.y - labelHeight);
      ctx.fillStyle = '#ff6b00';
      ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(box.ref, labelX + 8, labelY + labelHeight - 8);
    }
    return surface.toBuffer('image/png');
  } catch {
    return null;
  }
}

export async function analyzeBrowserScreenshot(params: {
  screenshot: BrowserScreenshotResult;
  question: string;
  annotate?: boolean;
  annotationBoxes?: AnnotationBox[];
  fallbackContext: BrowserVisionContext;
  taskModels?: TaskModelPolicies;
}): Promise<BrowserVisionResult> {
  pruneOldArtifacts();

  const imageBuffer = Buffer.from(params.screenshot.base64, 'base64');
  const imagePath = nextArtifactPath('browser-vision');
  fs.writeFileSync(imagePath, imageBuffer);

  let analysisImage: Buffer = imageBuffer;
  let annotatedPath: string | undefined;
  if (params.annotate && params.annotationBoxes?.length) {
    const annotated = await annotateScreenshot(imageBuffer, params.annotationBoxes);
    if (annotated) {
      annotatedPath = nextArtifactPath('browser-vision-annotated');
      fs.writeFileSync(annotatedPath, annotated);
      analysisImage = Buffer.from(annotated);
    }
  }

  const question = annotatedPath
    ? `${params.question}\n\nAnnotated refs are highlighted directly on the screenshot when available.`
    : params.question;

  const vision = await callAuxiliaryModel({
    task: 'vision',
    taskModels: params.taskModels,
    fallbackContext: params.fallbackContext,
    question,
    imageDataUrl: `data:image/png;base64,${analysisImage.toString('base64')}`,
    toolName: 'browser_use',
    missingContextSource: 'active request',
  });

  return {
    model: vision.model,
    analysis: vision.analysis,
    path: imagePath,
    annotatedPath,
  };
}
