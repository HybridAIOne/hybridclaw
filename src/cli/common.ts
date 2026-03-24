import type { SkillConfigChannelKind } from '../channels/channel.js';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';

export function normalizeArgs(args: string[]): string[] {
  return args.map((arg) => arg.trim()).filter(Boolean);
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
