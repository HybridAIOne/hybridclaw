import fs from 'fs';
import path from 'path';

/**
 * Load environment variables from <cwd>/.env with simple KEY=VALUE parsing.
 * Existing process.env values win over file values.
 */
export function loadEnvFile(cwd: string = process.cwd()): void {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();

    // Strip inline comments (# ...) unless the value is quoted.
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const hashIdx = val.indexOf('#');
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    } else {
      // Remove surrounding quotes.
      val = val.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}
