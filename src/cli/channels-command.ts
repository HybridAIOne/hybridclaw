import readline from 'node:readline/promises';

import {
  normalizeEmailAddress,
  normalizeEmailAllowEntry,
} from '../channels/email/allowlist.js';
import { normalizeIMessageHandle } from '../channels/imessage/handle.js';
import { assertLocalIMessageBackendReady } from '../channels/imessage/local-prereqs.js';
import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  type IMessageBackend,
  runtimeConfigPath,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import {
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { sleep } from '../utils/sleep.js';
import { normalizeArgs } from './common.js';
import { isHelpRequest, printChannelsUsage } from './help.js';
import {
  ensureWhatsAppAuthApi,
  ensureWhatsAppConnectionApi,
  ensureWhatsAppPhoneApi,
  getWhatsAppAuthApi,
  getWhatsAppConnectionApi,
  getWhatsAppPhoneApi,
} from './whatsapp-api.js';

function resolveWhatsAppSetupSettleMs(): number {
  const raw = String(
    process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS || '',
  ).trim();
  if (!raw) return 8_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 8_000;
  return Math.floor(parsed);
}

function parseWhatsAppSetupArgs(args: string[]): {
  allowFrom: string[];
  reset: boolean;
} {
  const allowFrom: string[] = [];
  let reset = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--reset') {
      reset = true;
      continue;
    }
    if (arg === '--allow-from') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--allow-from`.');
      const normalized = getWhatsAppPhoneApi().normalizePhoneNumber(next);
      if (!normalized) {
        throw new Error(
          `Invalid WhatsApp phone number: ${next}. Use E.164 format like +491701234567.`,
        );
      }
      allowFrom.push(normalized);
      index += 1;
      continue;
    }
    if (arg.startsWith('--allow-from=')) {
      const raw = arg.slice('--allow-from='.length);
      const normalized = getWhatsAppPhoneApi().normalizePhoneNumber(raw);
      if (!normalized) {
        throw new Error(
          `Invalid WhatsApp phone number: ${raw}. Use E.164 format like +491701234567.`,
        );
      }
      allowFrom.push(normalized);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...\`.`,
    );
  }

  return {
    allowFrom: [...new Set(allowFrom)],
    reset,
  };
}

function parseIntegerFlagValue(
  flagName: string,
  raw: string,
  options?: {
    min?: number;
    max?: number;
  },
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid value for \`${flagName}\`: ${raw}`);
  }
  const integer = Math.trunc(parsed);
  if (options?.min != null && integer < options.min) {
    throw new Error(`\`${flagName}\` must be at least ${options.min}.`);
  }
  if (options?.max != null && integer > options.max) {
    throw new Error(`\`${flagName}\` must be at most ${options.max}.`);
  }
  return integer;
}

function parseBooleanFlagValue(flagName: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case '1':
    case 'true':
    case 'yes':
    case 'y':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'n':
    case 'off':
      return false;
    default:
      throw new Error(`Invalid value for \`${flagName}\`: ${raw}`);
  }
}

function parseEmailSetupArgs(args: string[]): {
  address: string | null;
  password: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  pollIntervalMs: number | null;
  folders: string[];
  allowFrom: string[];
  textChunkLimit: number | null;
  mediaMaxMb: number | null;
} {
  let address: string | null = null;
  let password: string | null = null;
  let imapHost: string | null = null;
  let imapPort: number | null = null;
  let imapSecure: boolean | null = null;
  let smtpHost: string | null = null;
  let smtpPort: number | null = null;
  let smtpSecure: boolean | null = null;
  let pollIntervalMs: number | null = null;
  let textChunkLimit: number | null = null;
  let mediaMaxMb: number | null = null;
  const folders: string[] = [];
  const allowFrom: string[] = [];

  const parseAllowFrom = (raw: string): string => {
    const normalized = normalizeEmailAllowEntry(raw);
    if (!normalized) {
      throw new Error(
        `Invalid email allowlist entry: ${raw}. Use an email address, *@example.com, or *`,
      );
    }
    return normalized;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--address') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--address`.');
      const normalized = normalizeEmailAddress(next);
      if (!normalized) {
        throw new Error(`Invalid email address: ${next}`);
      }
      address = normalized;
      index += 1;
      continue;
    }
    if (arg.startsWith('--address=')) {
      const raw = arg.slice('--address='.length);
      const normalized = normalizeEmailAddress(raw);
      if (!normalized) {
        throw new Error(`Invalid email address: ${raw}`);
      }
      address = normalized;
      continue;
    }
    if (arg === '--password') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--password`.');
      password = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length).trim() || null;
      continue;
    }
    if (arg === '--imap-host') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--imap-host`.');
      imapHost = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--imap-host=')) {
      imapHost = arg.slice('--imap-host='.length).trim() || null;
      continue;
    }
    if (arg === '--imap-port') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--imap-port`.');
      imapPort = parseIntegerFlagValue('--imap-port', next, {
        min: 1,
        max: 65_535,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--imap-port=')) {
      imapPort = parseIntegerFlagValue(
        '--imap-port',
        arg.slice('--imap-port='.length),
        {
          min: 1,
          max: 65_535,
        },
      );
      continue;
    }
    if (arg === '--imap-secure') {
      imapSecure = true;
      continue;
    }
    if (arg === '--no-imap-secure') {
      imapSecure = false;
      continue;
    }
    if (arg.startsWith('--imap-secure=')) {
      imapSecure = parseBooleanFlagValue(
        '--imap-secure',
        arg.slice('--imap-secure='.length),
      );
      continue;
    }
    if (arg === '--smtp-host') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--smtp-host`.');
      smtpHost = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--smtp-host=')) {
      smtpHost = arg.slice('--smtp-host='.length).trim() || null;
      continue;
    }
    if (arg === '--smtp-port') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--smtp-port`.');
      smtpPort = parseIntegerFlagValue('--smtp-port', next, {
        min: 1,
        max: 65_535,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--smtp-port=')) {
      smtpPort = parseIntegerFlagValue(
        '--smtp-port',
        arg.slice('--smtp-port='.length),
        {
          min: 1,
          max: 65_535,
        },
      );
      continue;
    }
    if (arg === '--smtp-secure') {
      smtpSecure = true;
      continue;
    }
    if (arg === '--no-smtp-secure') {
      smtpSecure = false;
      continue;
    }
    if (arg.startsWith('--smtp-secure=')) {
      smtpSecure = parseBooleanFlagValue(
        '--smtp-secure',
        arg.slice('--smtp-secure='.length),
      );
      continue;
    }
    if (arg === '--poll-interval-ms') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--poll-interval-ms`.');
      pollIntervalMs = parseIntegerFlagValue('--poll-interval-ms', next, {
        min: 1_000,
        max: 3_600_000,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--poll-interval-ms=')) {
      pollIntervalMs = parseIntegerFlagValue(
        '--poll-interval-ms',
        arg.slice('--poll-interval-ms='.length),
        {
          min: 1_000,
          max: 3_600_000,
        },
      );
      continue;
    }
    if (arg === '--folder') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--folder`.');
      folders.push(next.trim());
      index += 1;
      continue;
    }
    if (arg.startsWith('--folder=')) {
      folders.push(arg.slice('--folder='.length).trim());
      continue;
    }
    if (arg === '--allow-from') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--allow-from`.');
      allowFrom.push(parseAllowFrom(next));
      index += 1;
      continue;
    }
    if (arg.startsWith('--allow-from=')) {
      allowFrom.push(parseAllowFrom(arg.slice('--allow-from='.length)));
      continue;
    }
    if (arg === '--text-chunk-limit') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--text-chunk-limit`.');
      textChunkLimit = parseIntegerFlagValue('--text-chunk-limit', next, {
        min: 500,
        max: 200_000,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--text-chunk-limit=')) {
      textChunkLimit = parseIntegerFlagValue(
        '--text-chunk-limit',
        arg.slice('--text-chunk-limit='.length),
        {
          min: 500,
          max: 200_000,
        },
      );
      continue;
    }
    if (arg === '--media-max-mb') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--media-max-mb`.');
      mediaMaxMb = parseIntegerFlagValue('--media-max-mb', next, {
        min: 1,
        max: 100,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--media-max-mb=')) {
      mediaMaxMb = parseIntegerFlagValue(
        '--media-max-mb',
        arg.slice('--media-max-mb='.length),
        {
          min: 1,
          max: 100,
        },
      );
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--smtp-host <host>]\`.`,
    );
  }

  return {
    address,
    password,
    imapHost,
    imapPort,
    imapSecure,
    smtpHost,
    smtpPort,
    smtpSecure,
    pollIntervalMs,
    folders: [...new Set(folders.filter(Boolean))],
    allowFrom: [...new Set(allowFrom)],
    textChunkLimit,
    mediaMaxMb,
  };
}

function parseIMessageSetupArgs(args: string[]): {
  allowFrom: string[];
  allowPrivateNetwork: boolean | null;
  backend: IMessageBackend | null;
  cliPath: string | null;
  dbPath: string | null;
  password: string | null;
  serverUrl: string | null;
  webhookPath: string | null;
} {
  const allowFrom: string[] = [];
  let allowPrivateNetwork: boolean | null = null;
  let backend: IMessageBackend | null = null;
  let cliPath: string | null = null;
  let dbPath: string | null = null;
  let password: string | null = null;
  let serverUrl: string | null = null;
  let webhookPath: string | null = null;

  const parseHandle = (raw: string): string => {
    const normalized = normalizeIMessageHandle(raw);
    if (!normalized) {
      throw new Error(
        `Invalid iMessage handle: ${raw}. Use a phone number, email address, or chat: group id.`,
      );
    }
    return normalized;
  };

  const parseBackend = (raw: string): IMessageBackend => {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'local') {
      return normalized;
    }
    if (normalized === 'remote') {
      return 'bluebubbles';
    }
    throw new Error(
      `Invalid value for \`--backend\`: ${raw}. Use \`local\` or \`remote\`.`,
    );
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--backend') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--backend`.');
      backend = parseBackend(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--backend=')) {
      backend = parseBackend(arg.slice('--backend='.length));
      continue;
    }
    if (arg === '--allow-from') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--allow-from`.');
      allowFrom.push(parseHandle(next));
      index += 1;
      continue;
    }
    if (arg.startsWith('--allow-from=')) {
      allowFrom.push(parseHandle(arg.slice('--allow-from='.length)));
      continue;
    }
    if (arg === '--cli-path') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--cli-path`.');
      cliPath = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--cli-path=')) {
      cliPath = arg.slice('--cli-path='.length).trim() || null;
      continue;
    }
    if (arg === '--db-path') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--db-path`.');
      dbPath = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--db-path=')) {
      dbPath = arg.slice('--db-path='.length).trim() || null;
      continue;
    }
    if (arg === '--server-url') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--server-url`.');
      serverUrl = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--server-url=')) {
      serverUrl = arg.slice('--server-url='.length).trim() || null;
      continue;
    }
    if (arg === '--password') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--password`.');
      password = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length).trim() || null;
      continue;
    }
    if (arg === '--webhook-path') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--webhook-path`.');
      webhookPath = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--webhook-path=')) {
      webhookPath = arg.slice('--webhook-path='.length).trim() || null;
      continue;
    }
    if (arg === '--allow-private-network') {
      allowPrivateNetwork = true;
      continue;
    }
    if (arg === '--no-allow-private-network') {
      allowPrivateNetwork = false;
      continue;
    }
    if (arg.startsWith('--allow-private-network=')) {
      allowPrivateNetwork = parseBooleanFlagValue(
        '--allow-private-network',
        arg.slice('--allow-private-network='.length),
      );
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw channels imessage setup [--backend <local|remote>] [--allow-from <handle>]... [--server-url <url>] [--password <password>] [--cli-path <path>] [--db-path <path>] [--webhook-path <path>] [--allow-private-network]\`.`,
    );
  }

  return {
    allowFrom: [...new Set(allowFrom)],
    allowPrivateNetwork,
    backend,
    cliPath,
    dbPath,
    password,
    serverUrl,
    webhookPath,
  };
}

function normalizeDiscordUserId(raw: string): string | null {
  const trimmed = raw.trim();
  const mentionMatch = trimmed.match(/^<@!?(\d{16,22})>$/);
  if (mentionMatch) return mentionMatch[1];
  const directMatch = trimmed.match(/^(?:user:|discord:)?(\d{16,22})$/i);
  return directMatch ? directMatch[1] : null;
}

function parseDiscordSetupArgs(args: string[]): {
  token: string | null;
  allowUserIds: string[];
  prefix: string | null;
} {
  let token: string | null = null;
  let prefix: string | null = null;
  const allowUserIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--token') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--token`.');
      token = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--token=')) {
      token = arg.slice('--token='.length).trim() || null;
      continue;
    }
    if (arg === '--allow-user-id') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--allow-user-id`.');
      const normalized = normalizeDiscordUserId(next);
      if (!normalized) {
        throw new Error(
          `Invalid Discord user id: ${next}. Use a Discord snowflake like 123456789012345678.`,
        );
      }
      allowUserIds.push(normalized);
      index += 1;
      continue;
    }
    if (arg.startsWith('--allow-user-id=')) {
      const raw = arg.slice('--allow-user-id='.length);
      const normalized = normalizeDiscordUserId(raw);
      if (!normalized) {
        throw new Error(
          `Invalid Discord user id: ${raw}. Use a Discord snowflake like 123456789012345678.`,
        );
      }
      allowUserIds.push(normalized);
      continue;
    }
    if (arg === '--prefix') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--prefix`.');
      prefix = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--prefix=')) {
      prefix = arg.slice('--prefix='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]\`.`,
    );
  }

  return {
    token,
    allowUserIds: [...new Set(allowUserIds)],
    prefix,
  };
}

async function promptWithDefault(params: {
  rl: readline.Interface;
  question: string;
  defaultValue?: string;
  validate?: (value: string) => string | null;
  errorMessage?: string;
}): Promise<string> {
  while (true) {
    const suffix = params.defaultValue ? ` [${params.defaultValue}]` : '';
    const raw = (
      await params.rl.question(`${params.question}${suffix}: `)
    ).trim();
    const candidate = raw || params.defaultValue || '';
    const validated = params.validate ? params.validate(candidate) : candidate;
    if (validated) return validated;
    console.log(params.errorMessage || 'Please enter a valid value.');
  }
}

async function resolveInteractiveEmailSetup(params: {
  address: string;
  allowFrom: string[];
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}): Promise<{
  address: string;
  allowFrom: string[];
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  password: string;
  passwordSource: 'explicit' | 'prompt' | 'env';
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}> {
  let address = params.address;
  let imapHost = params.imapHost;
  let smtpHost = params.smtpHost;
  let password = params.password;
  let passwordSource: 'explicit' | 'prompt' | 'env' = password
    ? 'explicit'
    : process.env.EMAIL_PASSWORD?.trim()
      ? 'env'
      : 'prompt';
  let allowFrom = params.allowFrom;

  const needsPrompt = !address || !imapHost || !smtpHost || !password;
  if (!needsPrompt) {
    return {
      address,
      allowFrom,
      imapHost,
      imapPort: params.imapPort,
      imapSecure: params.imapSecure,
      password,
      passwordSource,
      smtpHost,
      smtpPort: params.smtpPort,
      smtpSecure: params.smtpSecure,
    };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Missing email setup fields. Pass them as flags or run this command in an interactive terminal to be prompted.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    address = await promptWithDefault({
      rl,
      question: 'Email address',
      defaultValue: address || undefined,
      validate: normalizeEmailAddress,
      errorMessage: 'Enter a valid email address.',
    });
    imapHost = await promptWithDefault({
      rl,
      question: 'IMAP host',
      defaultValue: imapHost || undefined,
    });
    const imapPortRaw = await promptWithDefault({
      rl,
      question: 'IMAP port',
      defaultValue: String(params.imapPort),
      validate: (value) => {
        try {
          return String(
            parseIntegerFlagValue('--imap-port', value, {
              min: 1,
              max: 65_535,
            }),
          );
        } catch {
          return null;
        }
      },
      errorMessage: 'Enter a valid IMAP port.',
    });
    const imapSecureRaw = await promptWithDefault({
      rl,
      question: 'IMAP secure (TLS on connect)',
      defaultValue: String(params.imapSecure),
      validate: (value) => {
        try {
          return String(parseBooleanFlagValue('--imap-secure', value));
        } catch {
          return null;
        }
      },
      errorMessage: 'Enter true or false for IMAP secure.',
    });
    smtpHost = await promptWithDefault({
      rl,
      question: 'SMTP host',
      defaultValue: smtpHost || undefined,
    });
    const smtpPortRaw = await promptWithDefault({
      rl,
      question: 'SMTP port',
      defaultValue: String(params.smtpPort),
      validate: (value) => {
        try {
          return String(
            parseIntegerFlagValue('--smtp-port', value, {
              min: 1,
              max: 65_535,
            }),
          );
        } catch {
          return null;
        }
      },
      errorMessage: 'Enter a valid SMTP port.',
    });
    const smtpSecureRaw = await promptWithDefault({
      rl,
      question: 'SMTP secure (TLS on connect)',
      defaultValue: String(params.smtpSecure),
      validate: (value) => {
        try {
          return String(parseBooleanFlagValue('--smtp-secure', value));
        } catch {
          return null;
        }
      },
      errorMessage: 'Enter true or false for SMTP secure.',
    });

    if (!password) {
      password = await promptWithDefault({
        rl,
        question: 'Email password or app password',
      });
      passwordSource = 'prompt';
    }

    if (allowFrom.length === 0) {
      const allowFromRaw = (
        await rl.question(
          'Allowed inbound senders (optional, comma-separated emails, *@domain, or *): ',
        )
      ).trim();
      if (allowFromRaw) {
        allowFrom = allowFromRaw
          .split(',')
          .map((entry) => normalizeEmailAllowEntry(entry))
          .filter((entry): entry is string => Boolean(entry));
      }
    }

    return {
      address,
      allowFrom: [...new Set(allowFrom)],
      imapHost,
      imapPort: Number(imapPortRaw),
      imapSecure: parseBooleanFlagValue('--imap-secure', imapSecureRaw),
      password,
      passwordSource,
      smtpHost,
      smtpPort: Number(smtpPortRaw),
      smtpSecure: parseBooleanFlagValue('--smtp-secure', smtpSecureRaw),
    };
  } finally {
    rl.close();
  }
}

function configureDiscordChannel(args: string[]): void {
  ensureRuntimeConfigFile();
  const parsed = parseDiscordSetupArgs(args);
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.discord.commandsOnly = true;
    draft.discord.commandMode = 'restricted';
    draft.discord.commandAllowedUserIds = parsed.allowUserIds;
    draft.discord.commandUserId = '';
    draft.discord.groupPolicy = 'disabled';
    draft.discord.freeResponseChannels = [];
    draft.discord.guilds = {};
    if (parsed.prefix) {
      draft.discord.prefix = parsed.prefix;
    }
  });
  const secretsPath = parsed.token
    ? saveRuntimeSecrets({ DISCORD_TOKEN: parsed.token })
    : runtimeSecretsPath();

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  if (parsed.token) {
    console.log(`Saved Discord token to ${secretsPath}.`);
  } else {
    console.log(`Discord token unchanged. Secrets path: ${secretsPath}`);
  }
  console.log('Discord mode: command-only');
  console.log(`Discord prefix: ${nextConfig.discord.prefix}`);
  console.log(`Guild command mode: ${nextConfig.discord.commandMode}`);
  console.log(`Guild message policy: ${nextConfig.discord.groupPolicy}`);
  if (nextConfig.discord.commandAllowedUserIds.length > 0) {
    console.log(
      `Allowed guild users: ${nextConfig.discord.commandAllowedUserIds.join(', ')}`,
    );
  } else {
    console.log(
      'Allowed guild users: none configured (guild commands stay locked down until you add one)',
    );
  }
  console.log('Next:');
  console.log('  If provider auth is not set up yet: hybridclaw onboarding');
  if (!parsed.token) {
    console.log(
      `  Save DISCORD_TOKEN in ${secretsPath} or rerun with --token <token>`,
    );
  }
  console.log('  Restart the gateway to pick up Discord settings:');
  console.log('    hybridclaw gateway restart --foreground');
  console.log('    hybridclaw gateway status');
  console.log('  Invite the Discord bot to your server or open a DM with it');
  if (nextConfig.discord.commandAllowedUserIds.length > 0) {
    console.log(
      `  Test with an allowlisted guild user id: ${nextConfig.discord.commandAllowedUserIds[0]}`,
    );
  } else {
    console.log('  Use DMs first, or rerun with --allow-user-id <snowflake>');
  }
}

async function configureEmailChannel(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = parseEmailSetupArgs(args);
  const currentConfig = getRuntimeConfig().email;

  const resolved = await resolveInteractiveEmailSetup({
    address: parsed.address || currentConfig.address,
    allowFrom:
      parsed.allowFrom.length > 0 ? parsed.allowFrom : currentConfig.allowFrom,
    imapHost: parsed.imapHost || currentConfig.imapHost,
    imapPort: parsed.imapPort || currentConfig.imapPort,
    imapSecure: parsed.imapSecure ?? currentConfig.imapSecure,
    password:
      parsed.password?.trim() || process.env.EMAIL_PASSWORD?.trim() || '',
    smtpHost: parsed.smtpHost || currentConfig.smtpHost,
    smtpPort: parsed.smtpPort || currentConfig.smtpPort,
    smtpSecure: parsed.smtpSecure ?? currentConfig.smtpSecure,
  });

  const nextConfig = updateRuntimeConfig((draft) => {
    draft.email.enabled = true;
    draft.email.address = resolved.address;
    draft.email.imapHost = resolved.imapHost;
    draft.email.imapPort = resolved.imapPort;
    draft.email.imapSecure = resolved.imapSecure;
    draft.email.smtpHost = resolved.smtpHost;
    draft.email.smtpPort = resolved.smtpPort;
    draft.email.smtpSecure = resolved.smtpSecure;
    draft.email.pollIntervalMs =
      parsed.pollIntervalMs || draft.email.pollIntervalMs;
    draft.email.folders =
      parsed.folders.length > 0 ? parsed.folders : draft.email.folders;
    draft.email.allowFrom = resolved.allowFrom;
    draft.email.textChunkLimit =
      parsed.textChunkLimit || draft.email.textChunkLimit;
    draft.email.mediaMaxMb = parsed.mediaMaxMb || draft.email.mediaMaxMb;
  });

  const shouldSavePassword =
    resolved.passwordSource === 'prompt' || Boolean(parsed.password?.trim());
  const secretsPath = shouldSavePassword
    ? saveRuntimeSecrets({ EMAIL_PASSWORD: resolved.password })
    : runtimeSecretsPath();

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  if (shouldSavePassword) {
    console.log(`Saved email password to ${secretsPath}.`);
  } else {
    console.log(`Email password unchanged. Secrets path: ${secretsPath}`);
  }
  console.log('Email mode: enabled');
  console.log(`Email address: ${nextConfig.email.address}`);
  console.log(
    `IMAP: ${nextConfig.email.imapHost}:${nextConfig.email.imapPort}`,
  );
  console.log(`IMAP secure: ${nextConfig.email.imapSecure}`);
  console.log(
    `SMTP: ${nextConfig.email.smtpHost}:${nextConfig.email.smtpPort}`,
  );
  console.log(`SMTP secure: ${nextConfig.email.smtpSecure}`);
  console.log(`Folders: ${nextConfig.email.folders.join(', ')}`);
  if (nextConfig.email.allowFrom.length > 0) {
    console.log(`Allowed senders: ${nextConfig.email.allowFrom.join(', ')}`);
  } else {
    console.log('Allowed senders: none (inbound email stays disabled)');
  }
  console.log(`Poll interval: ${nextConfig.email.pollIntervalMs}ms`);
  console.log(`Text chunk limit: ${nextConfig.email.textChunkLimit}`);
  console.log(`Media limit: ${nextConfig.email.mediaMaxMb}MB`);
  console.log('Next:');
  console.log('  Restart the gateway to pick up email settings:');
  console.log('    hybridclaw gateway restart --foreground');
  console.log('    hybridclaw gateway status');
  if (nextConfig.email.allowFrom.length > 0) {
    console.log(
      `  Send a test message from an allowlisted sender to ${nextConfig.email.address}`,
    );
  } else {
    console.log(
      '  Add one or more allowlisted senders to receive inbound mail, or use email only for outbound sends',
    );
  }
}

async function pairWhatsAppChannel(): Promise<void> {
  const settleMs = resolveWhatsAppSetupSettleMs();
  const manager = getWhatsAppConnectionApi().createWhatsAppConnectionManager();
  try {
    console.log('Opening WhatsApp pairing session...');
    console.log(
      'Scan the QR code in WhatsApp: Settings > Linked Devices > Link a Device',
    );
    await manager.start();
    const socket = await manager.waitForSocket();
    console.log(`WhatsApp linked: ${socket.user?.id || 'connected'}`);
    if (settleMs > 0) {
      console.log(
        `Keeping the temporary setup session open for ${Math.floor(settleMs / 1000)}s so WhatsApp can finish linking...`,
      );
      await sleep(settleMs);
    }
  } finally {
    await manager.stop().catch(() => {});
  }
}

async function configureWhatsAppChannel(args: string[]): Promise<void> {
  await Promise.all([
    ensureWhatsAppAuthApi(),
    ensureWhatsAppConnectionApi(),
    ensureWhatsAppPhoneApi(),
  ]);
  ensureRuntimeConfigFile();
  const parsed = parseWhatsAppSetupArgs(args);
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.whatsapp.groupPolicy = 'disabled';
    draft.whatsapp.groupAllowFrom = [];
    draft.whatsapp.ackReaction = draft.whatsapp.ackReaction.trim() || '👀';
    if (parsed.allowFrom.length > 0) {
      draft.whatsapp.dmPolicy = 'allowlist';
      draft.whatsapp.allowFrom = parsed.allowFrom;
      return;
    }
    draft.whatsapp.dmPolicy = 'disabled';
    draft.whatsapp.allowFrom = [];
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(
    `WhatsApp mode: ${parsed.allowFrom.length > 0 ? 'allowlisted DMs only' : 'self-chat only'}`,
  );
  console.log(`DM policy: ${nextConfig.whatsapp.dmPolicy}`);
  if (nextConfig.whatsapp.allowFrom.length > 0) {
    console.log(`Allowed senders: ${nextConfig.whatsapp.allowFrom.join(', ')}`);
  }
  console.log(`Group policy: ${nextConfig.whatsapp.groupPolicy}`);
  console.log(
    `Ack reaction: ${nextConfig.whatsapp.ackReaction.trim() || '(disabled)'}`,
  );
  console.log(`Auth directory: ${getWhatsAppAuthApi().WHATSAPP_AUTH_DIR}`);
  if (parsed.reset) {
    await getWhatsAppAuthApi().resetWhatsAppAuthState();
    console.log(
      `Reset WhatsApp auth state at ${getWhatsAppAuthApi().WHATSAPP_AUTH_DIR}`,
    );
  }
  await pairWhatsAppChannel();
}

function configureIMessageChannel(args: string[]): void {
  ensureRuntimeConfigFile();
  const parsed = parseIMessageSetupArgs(args);
  const currentConfig = getRuntimeConfig().imessage;
  const backend = parsed.backend || currentConfig.backend;
  const cliPath = parsed.cliPath || currentConfig.cliPath;

  if (
    backend === 'bluebubbles' &&
    !(parsed.serverUrl?.trim() || currentConfig.serverUrl.trim())
  ) {
    throw new Error(
      'Remote iMessage setup requires `--server-url <url>` or an existing `imessage.serverUrl` value.',
    );
  }
  if (backend === 'local') {
    assertLocalIMessageBackendReady(cliPath);
  }

  const nextConfig = updateRuntimeConfig((draft) => {
    draft.imessage.enabled = true;
    draft.imessage.backend = backend;
    draft.imessage.groupPolicy = 'disabled';
    draft.imessage.groupAllowFrom = [];
    draft.imessage.allowFrom = parsed.allowFrom;
    draft.imessage.dmPolicy =
      parsed.allowFrom.length > 0 ? 'allowlist' : 'disabled';
    if (cliPath) {
      draft.imessage.cliPath = cliPath;
    }
    if (parsed.dbPath) {
      draft.imessage.dbPath = parsed.dbPath;
    }
    if (parsed.serverUrl) {
      draft.imessage.serverUrl = parsed.serverUrl;
    }
    if (parsed.webhookPath) {
      draft.imessage.webhookPath = parsed.webhookPath;
    }
    if (parsed.allowPrivateNetwork != null) {
      draft.imessage.allowPrivateNetwork = parsed.allowPrivateNetwork;
    }
    if (backend === 'bluebubbles') {
      draft.imessage.password = '';
    }
  });

  const shouldSavePassword =
    backend === 'bluebubbles' && Boolean(parsed.password?.trim());
  const secretsPath = shouldSavePassword
    ? saveRuntimeSecrets({ IMESSAGE_PASSWORD: parsed.password })
    : runtimeSecretsPath();

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  if (backend === 'bluebubbles') {
    if (shouldSavePassword) {
      console.log(`Saved iMessage password to ${secretsPath}.`);
    } else {
      console.log(`iMessage password unchanged. Secrets path: ${secretsPath}`);
    }
  }
  console.log('iMessage mode: enabled');
  console.log(
    `Backend: ${nextConfig.imessage.backend === 'bluebubbles' ? 'remote' : nextConfig.imessage.backend}`,
  );
  console.log(`DM policy: ${nextConfig.imessage.dmPolicy}`);
  if (nextConfig.imessage.allowFrom.length > 0) {
    console.log(`Allowed senders: ${nextConfig.imessage.allowFrom.join(', ')}`);
  } else {
    console.log('Allowed senders: none (inbound iMessage stays disabled)');
  }
  console.log(`Group policy: ${nextConfig.imessage.groupPolicy}`);
  if (backend === 'local') {
    console.log(`CLI path: ${nextConfig.imessage.cliPath}`);
    console.log(`Messages DB: ${nextConfig.imessage.dbPath}`);
  } else {
    console.log(`Remote relay URL: ${nextConfig.imessage.serverUrl}`);
    console.log(`Webhook path: ${nextConfig.imessage.webhookPath}`);
    console.log(
      `Allow private network: ${nextConfig.imessage.allowPrivateNetwork}`,
    );
  }
  console.log('Next:');
  console.log('  Restart the gateway to pick up iMessage settings:');
  console.log('    hybridclaw gateway restart --foreground');
  console.log('    hybridclaw gateway status');
  if (backend === 'local') {
    console.log(
      '  Make sure the Mac account can already send iMessages and the shell has Full Disk Access',
    );
  } else {
    console.log(
      '  Point your remote iMessage relay webhook at /api/imessage/webhook and send X-HybridClaw-iMessage-Password on webhook requests',
    );
  }
  if (nextConfig.imessage.allowFrom.length > 0) {
    console.log(
      `  Send a test iMessage from ${nextConfig.imessage.allowFrom[0]}`,
    );
  } else {
    console.log(
      '  Rerun with --allow-from <phone|email> to allow inbound iMessage replies',
    );
  }
}

export async function handleChannelsCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printChannelsUsage();
    return;
  }

  const channel = normalized[0].toLowerCase();
  if (
    channel !== 'whatsapp' &&
    channel !== 'discord' &&
    channel !== 'email' &&
    channel !== 'imessage'
  ) {
    throw new Error(
      `Unknown channel "${normalized[0]}". Currently supported: \`discord\`, \`whatsapp\`, \`email\`, \`imessage\`.`,
    );
  }

  const sub = (normalized[1] || '').toLowerCase();
  if (!sub || isHelpRequest([sub])) {
    printChannelsUsage();
    return;
  }
  if (sub === 'setup') {
    if (channel === 'discord') {
      configureDiscordChannel(normalized.slice(2));
      return;
    }
    if (channel === 'email') {
      await configureEmailChannel(normalized.slice(2));
      return;
    }
    if (channel === 'imessage') {
      configureIMessageChannel(normalized.slice(2));
      return;
    }
    await configureWhatsAppChannel(normalized.slice(2));
    return;
  }

  throw new Error(
    `Unknown channels subcommand: ${sub}. Use \`hybridclaw channels discord setup\`, \`hybridclaw channels whatsapp setup\`, \`hybridclaw channels email setup\`, or \`hybridclaw channels imessage setup\`.`,
  );
}
