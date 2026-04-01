import fs from 'node:fs';
import { runtimeSecretsPath } from '../../security/runtime-secrets.js';
import type { DiagResult } from '../types.js';
import {
  buildChmodFix,
  formatMode,
  isGroupOrWorldReadable,
  makeResult,
  readUnixMode,
  shortenHomePath,
  toErrorMessage,
} from '../utils.js';

export async function checkCredentials(): Promise<DiagResult[]> {
  const filePath = runtimeSecretsPath();
  const displayPath = shortenHomePath(filePath);

  if (!fs.existsSync(filePath)) {
    const sharedEnvSecrets = [
      process.env.HYBRIDAI_API_KEY,
      process.env.OPENROUTER_API_KEY,
      process.env.MISTRAL_API_KEY,
      process.env.DISCORD_TOKEN,
      process.env.EMAIL_PASSWORD,
      process.env.MSTEAMS_APP_PASSWORD,
    ].filter((value) => String(value || '').trim()).length;
    return [
      makeResult(
        'credentials',
        'Credentials',
        sharedEnvSecrets > 0 ? 'ok' : 'warn',
        sharedEnvSecrets > 0
          ? `${displayPath} not present; using environment-backed secrets`
          : `${displayPath} not present`,
      ),
    ];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch (error) {
    return [
      makeResult(
        'credentials',
        'Credentials',
        'error',
        `${displayPath} is not valid JSON (${toErrorMessage(error)})`,
      ),
    ];
  }

  const mode = readUnixMode(filePath);
  const insecurePermissions = isGroupOrWorldReadable(mode);
  const keys = Object.entries(parsed.entries || {}).filter(
    ([, value]) =>
      typeof value === 'object' &&
      value != null &&
      typeof (value as Record<string, unknown>).nonce === 'string' &&
      typeof (value as Record<string, unknown>).ciphertext === 'string',
  );
  const legacyPlaintextKeys =
    keys.length === 0
      ? Object.keys(parsed).filter(
          (key) =>
            typeof parsed[key] === 'string' && String(parsed[key]).trim(),
        )
      : [];
  const severity =
    keys.length === 0 && legacyPlaintextKeys.length === 0
      ? 'warn'
      : insecurePermissions || legacyPlaintextKeys.length > 0
        ? 'warn'
        : 'ok';
  const details = [
    `${displayPath} has ${keys.length || legacyPlaintextKeys.length} stored secret${keys.length + legacyPlaintextKeys.length === 1 ? '' : 's'}`,
  ];
  if (insecurePermissions) details.push(`permissions ${formatMode(mode)}`);
  if (legacyPlaintextKeys.length > 0) details.push('legacy plaintext format');

  return [
    makeResult(
      'credentials',
      'Credentials',
      severity,
      details.join(', '),
      insecurePermissions
        ? buildChmodFix(
            filePath,
            0o600,
            `Restrict ${displayPath} permissions to owner-only`,
          )
        : undefined,
    ),
  ];
}
