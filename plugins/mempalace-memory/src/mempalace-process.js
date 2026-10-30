import {
  normalizeText,
  runBoundedCli,
  truncateText,
} from '@hybridaione/hybridclaw/plugin-sdk';

function buildInvocationArgs(subcommandArgs, config) {
  const args = [];
  if (config.palacePath) {
    args.push('--palace', config.palacePath);
  }
  args.push(...subcommandArgs);
  return args;
}

export async function runMempalace(subcommandArgs, config, options = {}) {
  return await runBoundedCli({
    command: config.command,
    args: buildInvocationArgs(subcommandArgs, config),
    cwd: config.workingDirectory,
    timeoutMs:
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs)
        ? options.timeoutMs
        : config.timeoutMs,
    maxChars: options.maxChars,
    label: 'MemPalace',
  });
}

export async function runMempalaceCommandText(subcommandArgs, config, options) {
  const result = await runMempalace(subcommandArgs, config, options);
  if (!result.ok) {
    throw result.error;
  }
  return normalizeText(result.stdout);
}

export function cleanWakeUpText(value, maxChars) {
  const normalized = normalizeText(value)
    .replace(/^Wake-up text\s*\(~\d+\s+tokens\):\n=+\n?/i, '')
    .trim();
  return truncateText(normalized, maxChars);
}

export function cleanSearchText(value, maxChars) {
  return truncateText(normalizeText(value), maxChars);
}
