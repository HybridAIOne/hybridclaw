/**
 * Agent activation can read an existing pairing before plugins have loaded.
 * The transport plugin owns writes to this credential directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../../config/runtime-paths.js';

export const WHATSAPP_AUTH_DIR = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'credentials',
  'whatsapp',
);

export function isWhatsAppLinked(authDir = WHATSAPP_AUTH_DIR): boolean {
  try {
    const creds = JSON.parse(
      fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8'),
    );
    return (
      creds?.registered === true ||
      (typeof creds?.me?.id === 'string' && creds.me.id.trim().length > 0)
    );
  } catch {
    return false;
  }
}
