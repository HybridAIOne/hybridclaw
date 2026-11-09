/**
 * Read-only view of the WhatsApp link the plugin stores under
 * `<data dir>/credentials/whatsapp`, for core decisions that must stay
 * synchronous (binding a running channel to its agent).
 *
 * The plugin owns this directory: credential writes, the lock, pairing, and
 * reset live there. NOT the plugin's `getAuthStatus`, which is what gateway
 * status, doctor, and sends ask.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../../config/runtime-paths.js';

const WHATSAPP_CREDS_PATH = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'credentials',
  'whatsapp',
  'creds.json',
);

export function isWhatsAppLinked(): boolean {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(WHATSAPP_CREDS_PATH, 'utf-8'),
    ) as { registered?: unknown; me?: { id?: unknown } | null };
    const id = parsed?.me?.id;
    return (
      (typeof id === 'string' && id.trim() !== '') ||
      parsed?.registered === true
    );
  } catch {
    return false;
  }
}
