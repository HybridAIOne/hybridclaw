import fs from 'node:fs';
import YAML from 'yaml';

import type { ChannelKind } from '../channels/channel.js';
import { normalizeChannelKind } from '../channels/channel-registry.js';
import { isRecord } from '../utils/type-guards.js';

export interface SkillManifestCredential {
  id: string;
  env?: string;
  description?: string;
  required: boolean;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  requiredCredentials: SkillManifestCredential[];
  supportedChannels: ChannelKind[];
}

export const DEFAULT_SKILL_SUPPORTED_CHANNELS: readonly ChannelKind[] = [
  'discord',
  'email',
  'imessage',
  'msteams',
  'signal',
  'slack',
  'telegram',
  'tui',
  'voice',
  'whatsapp',
];

const SEMVERISH_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'skill';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? stripQuotes(value).trim() : '';
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map((entry) => normalizeString(entry))
          .filter((entry) => entry.length > 0),
      ),
    ];
  }
  const raw = normalizeString(value);
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((entry) => stripQuotes(entry).trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeCapability(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9:/.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeCapabilities(value: unknown): string[] {
  return normalizeStringList(value)
    .map((entry) => normalizeCapability(entry))
    .filter(Boolean);
}

function normalizeRequiredCredentials(
  value: unknown,
): SkillManifestCredential[] {
  const rawItems = Array.isArray(value) ? value : normalizeStringList(value);
  const credentials: SkillManifestCredential[] = [];
  const seen = new Set<string>();

  for (const item of rawItems) {
    let credential: SkillManifestCredential | null = null;
    if (typeof item === 'string') {
      const id = slugify(item);
      credential = { id, required: true };
    } else if (isRecord(item)) {
      const id =
        normalizeString(item.id) ||
        normalizeString(item.name) ||
        normalizeString(item.key);
      if (!id) continue;
      const env = normalizeString(item.env);
      const description = normalizeString(item.description);
      credential = {
        id: slugify(id),
        ...(env ? { env } : {}),
        ...(description ? { description } : {}),
        required: item.required === undefined ? true : item.required !== false,
      };
    }

    if (!credential || seen.has(credential.id)) continue;
    seen.add(credential.id);
    credentials.push(credential);
  }

  return credentials;
}

function normalizeSupportedChannels(value: unknown): ChannelKind[] {
  const raw = normalizeStringList(value);
  if (raw.length === 0) return [...DEFAULT_SKILL_SUPPORTED_CHANNELS];

  const channels: ChannelKind[] = [];
  const seen = new Set<ChannelKind>();
  for (const item of raw) {
    const normalized =
      item.trim().toLowerCase() === 'web' ? 'tui' : normalizeChannelKind(item);
    if (!normalized) continue;
    if (!DEFAULT_SKILL_SUPPORTED_CHANNELS.includes(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    channels.push(normalized);
  }

  return channels.length > 0 ? channels : [...DEFAULT_SKILL_SUPPORTED_CHANNELS];
}

function parseFrontmatterObject(raw: string): Record<string, unknown> {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1] || '') as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readRecordPath(
  record: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | null {
  let current: unknown = record;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return isRecord(current) ? current : null;
}

interface ManifestFieldSource {
  label: string;
  record: Record<string, unknown> | null;
}

function buildManifestFieldSources(frontmatter: Record<string, unknown>): {
  hybridclaw: Record<string, unknown> | null;
  sources: ManifestFieldSource[];
} {
  const metadata = readRecordPath(frontmatter, ['metadata']);
  const hybridclaw =
    readRecordPath(frontmatter, ['metadata', 'hybridclaw']) ||
    readRecordPath(frontmatter, ['metadata', 'openclaw']);

  // Field lookup precedence, highest first. Keep future manifest fields on this
  // ordered source list instead of adding ad hoc fallback chains.
  const sources: ManifestFieldSource[] = [
    {
      label: 'manifest',
      record: readRecordPath(frontmatter, ['manifest']),
    },
    {
      label: 'metadata.hybridclaw.manifest / metadata.openclaw.manifest',
      record:
        readRecordPath(frontmatter, ['metadata', 'hybridclaw', 'manifest']) ||
        readRecordPath(frontmatter, ['metadata', 'openclaw', 'manifest']),
    },
    {
      label: 'metadata.hybridclaw / metadata.openclaw',
      record: hybridclaw,
    },
    {
      label: 'metadata',
      record: metadata,
    },
    {
      label: 'frontmatter',
      record: frontmatter,
    },
  ];

  return { hybridclaw, sources };
}

function findFirstValue(
  sources: readonly ManifestFieldSource[],
  keys: readonly string[],
): unknown {
  for (const source of sources) {
    const record = source.record;
    if (!record) continue;
    for (const key of keys) {
      if (Object.hasOwn(record, key)) return record[key];
    }
  }
  return undefined;
}

export function parseSkillManifestFromMarkdown(
  raw: string,
  fallback: { name: string },
): SkillManifest {
  const frontmatter = parseFrontmatterObject(raw);
  const { hybridclaw, sources } = buildManifestFieldSources(frontmatter);

  const name = normalizeString(frontmatter.name) || fallback.name;
  const id =
    normalizeString(findFirstValue(sources, ['id', 'skillId', 'skill_id'])) ||
    slugify(name);
  const rawVersion = normalizeString(findFirstValue(sources, ['version']));
  const version = SEMVERISH_RE.test(rawVersion) ? rawVersion : '0.0.0';
  const rawCredentials =
    findFirstValue(sources, [
      'requiredCredentials',
      'required_credentials',
      'credentials',
    ]) ?? readRecordPath(hybridclaw || {}, ['credentials'])?.required;
  const rawChannels = findFirstValue(sources, [
    'supportedChannels',
    'supported_channels',
    'channels',
  ]);

  return {
    id: slugify(id),
    name,
    version,
    capabilities: normalizeCapabilities(
      findFirstValue(sources, ['capabilities']),
    ),
    requiredCredentials: normalizeRequiredCredentials(rawCredentials),
    supportedChannels: normalizeSupportedChannels(rawChannels),
  };
}

export function parseSkillManifestFile(
  skillFilePath: string,
  fallback: { name: string },
): SkillManifest {
  return parseSkillManifestFromMarkdown(
    fs.readFileSync(skillFilePath, 'utf-8'),
    fallback,
  );
}

export function isSkillSupportedOnChannel(
  manifest: Pick<SkillManifest, 'supportedChannels'>,
  channelKind?: string | null,
): boolean {
  const normalized = normalizeChannelKind(channelKind);
  if (!normalized) return true;
  return manifest.supportedChannels.includes(normalized);
}
