import fs from 'node:fs';
import YAML from 'yaml';

import type { ChannelKind } from '../channels/channel.js';
import { normalizeChannelKind } from '../channels/channel-registry.js';
import { parseSecretInput } from '../security/secret-refs.js';
import { isRecord } from '../utils/type-guards.js';

export interface SkillManifestCredential {
  id: string;
  env?: string;
  description?: string;
  required: boolean;
}

export type SkillManifestCredentialKind =
  | 'api_key'
  | 'oauth'
  | 'browser_login'
  | 'bearer'
  | 'header';

export interface SkillManifestSecretRef {
  source: 'env' | 'store';
  id: string;
}

export interface SkillManifestDeclaredCredential {
  id: string;
  kind: SkillManifestCredentialKind;
  required: boolean;
  secretRef: SkillManifestSecretRef;
  scope: string;
  howToObtain: string;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  middleware: SkillManifestMiddleware;
  requiredCredentials: SkillManifestCredential[];
  credentials: SkillManifestDeclaredCredential[];
  supportedChannels: ChannelKind[];
}

export interface SkillManifestMiddleware {
  preSend: boolean;
  postReceive: boolean;
}

export interface SkillManifestParseOptions {
  requireVersion?: boolean;
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
const CREDENTIAL_KINDS: readonly SkillManifestCredentialKind[] = [
  'api_key',
  'oauth',
  'browser_login',
  'bearer',
  'header',
];

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

function normalizeMiddleware(value: unknown): SkillManifestMiddleware {
  if (!isRecord(value)) {
    return {
      preSend: false,
      postReceive: false,
    };
  }
  return {
    preSend: value.pre_send === true || value.preSend === true,
    postReceive: value.post_receive === true || value.postReceive === true,
  };
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

function credentialFieldError(path: string, message: string): never {
  throw new Error(`Invalid skill credentials frontmatter: ${path} ${message}.`);
}

function normalizeCredentialId(value: unknown, path: string): string {
  const id = normalizeString(value);
  if (!id) credentialFieldError(path, 'is required');
  return slugify(id);
}

function normalizeCredentialKind(
  value: unknown,
  path: string,
): SkillManifestCredentialKind {
  const kind = normalizeString(value);
  if (!kind) credentialFieldError(path, 'is required');
  if (!CREDENTIAL_KINDS.includes(kind as SkillManifestCredentialKind)) {
    credentialFieldError(path, `must be one of ${CREDENTIAL_KINDS.join(', ')}`);
  }
  return kind as SkillManifestCredentialKind;
}

function normalizeCredentialRequired(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    credentialFieldError(path, 'must be true or false');
  }
  return value;
}

function normalizeCredentialSecretRef(
  value: unknown,
  path: string,
): SkillManifestSecretRef {
  const parsed = parseSecretInput(value);
  if (parsed.kind === 'plain') {
    credentialFieldError(path, 'must be a SecretRef binding');
  }
  if (parsed.kind === 'invalid') {
    credentialFieldError(path, parsed.reason);
  }
  return {
    source: parsed.ref.source,
    id: parsed.ref.id,
  };
}

function normalizeCredentialStringField(value: unknown, path: string): string {
  const normalized = normalizeString(value);
  if (!normalized) credentialFieldError(path, 'is required');
  return normalized;
}

function normalizeDeclaredCredentials(
  value: unknown,
): SkillManifestDeclaredCredential[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    credentialFieldError('credentials', 'must be a list');
  }

  const credentials: SkillManifestDeclaredCredential[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `credentials[${index}]`;
    if (!isRecord(item)) {
      credentialFieldError(itemPath, 'must be an object');
    }

    const id = normalizeCredentialId(item.id, `${itemPath}.id`);
    if (seen.has(id)) {
      credentialFieldError(`${itemPath}.id`, `duplicates credential "${id}"`);
    }
    seen.add(id);

    credentials.push({
      id,
      kind: normalizeCredentialKind(item.kind, `${itemPath}.kind`),
      required: normalizeCredentialRequired(
        item.required,
        `${itemPath}.required`,
      ),
      secretRef: normalizeCredentialSecretRef(
        item.secret_ref ?? item.secretRef,
        `${itemPath}.secret_ref`,
      ),
      scope: normalizeCredentialStringField(item.scope, `${itemPath}.scope`),
      howToObtain: normalizeCredentialStringField(
        item.how_to_obtain ?? item.howToObtain,
        `${itemPath}.how_to_obtain`,
      ),
    });
  });

  return credentials;
}

function mergeRequiredCredentials(
  legacy: SkillManifestCredential[],
  declared: SkillManifestDeclaredCredential[],
): SkillManifestCredential[] {
  const merged: SkillManifestCredential[] = [];
  const seen = new Set<string>();
  for (const credential of legacy) {
    if (seen.has(credential.id)) continue;
    seen.add(credential.id);
    merged.push(credential);
  }
  for (const credential of declared) {
    if (seen.has(credential.id)) continue;
    seen.add(credential.id);
    merged.push({
      id: credential.id,
      required: credential.required,
    });
  }
  return merged;
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

function parseFrontmatterBlockObject(block: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(block) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(
      `Invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseFrontmatterObject(raw: string): Record<string, unknown> {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  return parseFrontmatterBlockObject(match[1] || '');
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
  options: SkillManifestParseOptions = {},
): SkillManifest {
  return parseSkillManifestFromFrontmatterObject(
    parseFrontmatterObject(raw),
    fallback,
    options,
  );
}

export function parseSkillManifestFromFrontmatterBlock(
  block: string,
  fallback: { name: string },
  options: SkillManifestParseOptions = {},
): SkillManifest {
  return parseSkillManifestFromFrontmatterObject(
    parseFrontmatterBlockObject(block),
    fallback,
    options,
  );
}

function parseSkillManifestFromFrontmatterObject(
  frontmatter: Record<string, unknown>,
  fallback: { name: string },
  options: SkillManifestParseOptions,
): SkillManifest {
  const { hybridclaw, sources } = buildManifestFieldSources(frontmatter);

  const name = normalizeString(frontmatter.name) || fallback.name;
  const id =
    normalizeString(findFirstValue(sources, ['id', 'skillId', 'skill_id'])) ||
    slugify(name);
  const rawVersion = normalizeString(findFirstValue(sources, ['version']));
  const version = SEMVERISH_RE.test(rawVersion) ? rawVersion : null;
  if (!version && options.requireVersion) {
    const reason = rawVersion
      ? `invalid version "${rawVersion}"`
      : 'missing version';
    throw new Error(
      `Skill manifest for "${name}" has ${reason}; packaged skills must declare a semantic version like 1.2.3.`,
    );
  }
  const rawCredentials =
    findFirstValue(sources, ['requiredCredentials', 'required_credentials']) ??
    readRecordPath(hybridclaw || {}, ['credentials'])?.required;
  const declaredCredentials = normalizeDeclaredCredentials(
    frontmatter.credentials,
  );
  const rawChannels = findFirstValue(sources, [
    'supportedChannels',
    'supported_channels',
    'channels',
  ]);
  const rawMiddleware = findFirstValue(sources, ['middleware']);

  return {
    id: slugify(id),
    name,
    version: version || '0.0.0',
    capabilities: normalizeCapabilities(
      findFirstValue(sources, ['capabilities']),
    ),
    middleware: normalizeMiddleware(rawMiddleware),
    requiredCredentials: mergeRequiredCredentials(
      normalizeRequiredCredentials(rawCredentials),
      declaredCredentials,
    ),
    credentials: declaredCredentials,
    supportedChannels: normalizeSupportedChannels(rawChannels),
  };
}

export function parseSkillManifestFile(
  skillFilePath: string,
  fallback: { name: string },
  options: SkillManifestParseOptions = {},
): SkillManifest {
  return parseSkillManifestFromMarkdown(
    fs.readFileSync(skillFilePath, 'utf-8'),
    fallback,
    options,
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
