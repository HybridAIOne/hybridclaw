import fs from 'node:fs';
import {
  normalizeCliText,
  runBoundedCli,
} from '@hybridaione/hybridclaw/plugin-sdk';

export function truncateByteRoverText(value, maxChars) {
  const normalized = normalizeCliText(value);
  if (!maxChars || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export async function runByteRover(subcommandArgs, config, options = {}) {
  fs.mkdirSync(config.workingDirectory, { recursive: true });
  const apiKey =
    typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  return await runBoundedCli({
    command: config.command,
    args: subcommandArgs.map((arg) => String(arg)),
    cwd: config.workingDirectory,
    env: apiKey ? { BRV_API_KEY: apiKey } : {},
    timeoutMs:
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs)
        ? options.timeoutMs
        : config.queryTimeoutMs,
    maxChars: options.maxChars,
    label: 'ByteRover',
  });
}

export async function runByteRoverCommandText(
  subcommandArgs,
  config,
  options = {},
) {
  const result = await runByteRover(subcommandArgs, config, options);
  if (!result.ok) {
    throw result.error;
  }
  return truncateByteRoverText(result.stdout, options.maxChars);
}
