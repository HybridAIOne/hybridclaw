import fs from 'node:fs';
import {
  normalizeText,
  runBoundedCli,
  truncateText,
} from '@hybridaione/hybridclaw/plugin-sdk';

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
  return truncateText(normalizeText(result.stdout), options.maxChars);
}
