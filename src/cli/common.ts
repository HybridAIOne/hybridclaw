import type { SkillConfigChannelKind } from '../channels/channel.js';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';

export function makeLazyApi<T>(
  importer: () => Promise<T>,
  notInitializedMessage: string,
): {
  ensure: () => Promise<T>;
  get: () => T;
} {
  let api: T | null = null;
  let promise: Promise<T> | null = null;

  return {
    async ensure(): Promise<T> {
      if (api) return api;
      promise ??= importer();
      api = await promise;
      return api;
    },
    get(): T {
      if (!api) {
        throw new Error(notInitializedMessage);
      }
      return api;
    },
  };
}

export function normalizeArgs(args: string[]): string[] {
  return args.map((arg) => arg.trim()).filter(Boolean);
}

export function parseValueFlag(params: {
  arg: string;
  args: string[];
  index: number;
  names: string[];
  placeholder: string;
  displayName?: string;
  allowEmptyEquals?: boolean;
}): { value: string; nextIndex: number } | null {
  const {
    arg,
    args,
    index,
    names,
    placeholder,
    displayName,
    allowEmptyEquals = false,
  } = params;

  for (const name of names) {
    const label = displayName || name;
    if (arg === name) {
      const value = String(args[index + 1] || '').trim();
      if (!value) {
        throw new Error(
          `Missing value for \`${label}\`. Use \`${label} ${placeholder}\`.`,
        );
      }
      return {
        value,
        nextIndex: index + 1,
      };
    }

    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(`${name}=`.length).trim();
      if (!value && !allowEmptyEquals) {
        throw new Error(`Missing value for \`${label}=${placeholder}\`.`);
      }
      return {
        value,
        nextIndex: index,
      };
    }
  }

  return null;
}

function parseSkillChannelKind(
  value: string,
): SkillConfigChannelKind | undefined {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'global') return undefined;
  const channelKind = normalizeSkillConfigChannelKind(raw);
  if (!channelKind) {
    throw new Error(`Unsupported channel kind: ${value}`);
  }
  return channelKind;
}

export function parseSkillScopeArgs(args: string[]): {
  channelKind?: SkillConfigChannelKind;
  remaining: string[];
} {
  const remaining: string[] = [];
  let channelKind: SkillConfigChannelKind | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--channel') {
      const next = args[index + 1];
      if (!next) {
        throw new Error('Missing value for `--channel`.');
      }
      channelKind = parseSkillChannelKind(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--channel=')) {
      channelKind = parseSkillChannelKind(arg.slice('--channel='.length));
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    remaining.push(arg);
  }

  return { channelKind, remaining };
}
