import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/config.js';
import { GATEWAY_MODEL_RESPONSE_DEBUG_PATH } from '../gateway/gateway-lifecycle.js';

const MODEL_RESPONSE_DEBUG_FILE_RE =
  /^\[model-response-debug-file\]\s+([A-Za-z0-9+/=]+)$/;
const LAST_PROMPT_FILE_RE = /^\[last-prompt-file\]\s+([A-Za-z0-9+/=]+)$/;
const LAST_PROMPT_PATH = path.join(DATA_DIR, 'last_prompt.jsonl');

export function consumeModelResponseDebugFileLine(line: string): boolean {
  const modelResponseMatch = line.match(MODEL_RESPONSE_DEBUG_FILE_RE);
  if (modelResponseMatch) {
    try {
      const decoded = Buffer.from(modelResponseMatch[1], 'base64').toString(
        'utf-8',
      );
      fs.mkdirSync(path.dirname(GATEWAY_MODEL_RESPONSE_DEBUG_PATH), {
        recursive: true,
      });
      fs.appendFileSync(GATEWAY_MODEL_RESPONSE_DEBUG_PATH, decoded, 'utf-8');
    } catch {
      // Debug logging must not disrupt model execution.
    }

    return true;
  }

  const lastPromptMatch = line.match(LAST_PROMPT_FILE_RE);
  if (!lastPromptMatch) return false;

  try {
    const decoded = Buffer.from(lastPromptMatch[1], 'base64').toString('utf-8');
    fs.mkdirSync(path.dirname(LAST_PROMPT_PATH), { recursive: true });
    fs.writeFileSync(LAST_PROMPT_PATH, decoded, 'utf-8');
  } catch {
    // Debug logging must not disrupt model execution.
  }

  return true;
}
