import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  GATEWAY_DEBUG_MODEL_RESPONSES_ENV,
  GATEWAY_MODEL_RESPONSE_DEBUG_PATH,
} from '../gateway/gateway-lifecycle.js';
import { logger } from '../logger.js';

const MODEL_RESPONSE_DEBUG_FILE_RE =
  /^\[model-response-debug-file\]\s+([A-Za-z0-9+/=]+)$/;
const LAST_PROMPT_FILE_RE = /^\[last-prompt-file\]\s+([A-Za-z0-9+/=]+)$/;
const LAST_PROMPT_PATH = path.join(DATA_DIR, 'last_prompt.jsonl');
const ensuredDebugDirs = new Set<string>();
const MODEL_RESPONSE_DEBUG_ENABLED_VALUE = '1';
let lastWarnedModelResponseDebugValue: string | null = null;

function ensureDebugDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (ensuredDebugDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDebugDirs.add(dir);
}

export function isModelResponseDebugEnabled(): boolean {
  const raw = String(
    process.env[GATEWAY_DEBUG_MODEL_RESPONSES_ENV] || '',
  ).trim();
  if (!raw) return getRuntimeConfig().ops.debugModelResponses === true;
  if (raw === MODEL_RESPONSE_DEBUG_ENABLED_VALUE) {
    lastWarnedModelResponseDebugValue = null;
    return true;
  }
  if (raw !== lastWarnedModelResponseDebugValue) {
    logger.warn(
      {
        envVar: GATEWAY_DEBUG_MODEL_RESPONSES_ENV,
        expectedValue: MODEL_RESPONSE_DEBUG_ENABLED_VALUE,
        value: raw,
      },
      'Ignoring invalid gateway model response debug env value',
    );
    lastWarnedModelResponseDebugValue = raw;
  }
  return false;
}

export function consumeModelResponseDebugFileLine(line: string): boolean {
  const modelResponseMatch = line.match(MODEL_RESPONSE_DEBUG_FILE_RE);
  if (modelResponseMatch) {
    if (!isModelResponseDebugEnabled()) return true;

    try {
      const decoded = Buffer.from(modelResponseMatch[1], 'base64').toString(
        'utf-8',
      );
      ensureDebugDir(GATEWAY_MODEL_RESPONSE_DEBUG_PATH);
      fs.appendFileSync(GATEWAY_MODEL_RESPONSE_DEBUG_PATH, decoded, 'utf-8');
    } catch {
      // Debug logging must not disrupt model execution.
    }

    return true;
  }

  const lastPromptMatch = line.match(LAST_PROMPT_FILE_RE);
  if (!lastPromptMatch) return false;
  if (!isModelResponseDebugEnabled()) return true;

  try {
    const decoded = Buffer.from(lastPromptMatch[1], 'base64').toString('utf-8');
    ensureDebugDir(LAST_PROMPT_PATH);
    fs.writeFileSync(LAST_PROMPT_PATH, decoded, 'utf-8');
  } catch {
    // Debug logging must not disrupt model execution.
  }

  return true;
}
