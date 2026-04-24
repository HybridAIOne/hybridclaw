import fs from 'node:fs';
import path from 'node:path';
import { GATEWAY_MODEL_RESPONSE_DEBUG_PATH } from '../gateway/gateway-lifecycle.js';

const MODEL_RESPONSE_DEBUG_FILE_RE =
  /^\[model-response-debug-file\]\s+([A-Za-z0-9+/=]+)$/;

export function consumeModelResponseDebugFileLine(line: string): boolean {
  const match = line.match(MODEL_RESPONSE_DEBUG_FILE_RE);
  if (!match) return false;

  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
    fs.mkdirSync(path.dirname(GATEWAY_MODEL_RESPONSE_DEBUG_PATH), {
      recursive: true,
    });
    fs.appendFileSync(GATEWAY_MODEL_RESPONSE_DEBUG_PATH, decoded, 'utf-8');
  } catch {
    // Debug logging must not disrupt model execution.
  }

  return true;
}
