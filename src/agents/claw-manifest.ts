import path from 'node:path';

import { normalizeTrimmedString as normalizeString } from '../utils/normalized-strings.js';
import type { AgentModelConfig } from './agent-types.js';

export const CLAW_FORMAT_VERSION = 1 as const;

export interface ClawSkillExternalRef {
  kind: 'git';
  ref: string;
  name?: string;
}

export interface ClawSkillImportRef {
  source: string;
}

export interface ClawPluginExternalRef {
  kind: 'npm' | 'local';
  ref: string;
  id?: string;
}

export interface ClawPresentation {
  displayName?: string;
  imageAsset?: string;
}

export interface ClawManifest {
  formatVersion: typeof CLAW_FORMAT_VERSION;
  name: string;
  id?: string;
  description?: string;
  author?: string;
  version?: string;
  createdAt?: string;
  presentation?: ClawPresentation;
  agent?: {
    model?: AgentModelConfig;
    enableRag?: boolean;
  };
  skills?: {
    bundled?: string[];
    imports?: ClawSkillImportRef[];
    external?: ClawSkillExternalRef[];
  };
  plugins?: {
    bundled?: string[];
    external?: ClawPluginExternalRef[];
  };
  config?: {
    skills?: {
      disabled?: string[];
    };
    plugins?: {
      list?: Array<{
        id: string;
        enabled: boolean;
        config?: Record<string, unknown>;
      }>;
    };
  };
}

export interface ValidateClawManifestOptions {
  archiveEntries?: string[];
}

type ClawPluginConfigList = Array<{
  id: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeModelConfig(value: unknown): AgentModelConfig | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (!isRecord(value)) return undefined;

  const primary = normalizeString(value.primary);
  if (!primary) return undefined;
  const fallbacks = normalizeStringArray(value.fallbacks).filter(
    (entry) => entry !== primary,
  );
  return fallbacks.length > 0 ? { primary, fallbacks } : { primary };
}

function normalizePresentation(value: unknown): ClawPresentation | undefined {
  if (!isRecord(value)) return undefined;

  const displayName = normalizeString(value.displayName);
  const imageAsset = normalizeString(value.imageAsset);
  if (
    imageAsset &&
    (path.isAbsolute(imageAsset) ||
      imageAsset.includes('\\') ||
      imageAsset.split('/').some((segment) => segment === '..' || !segment))
  ) {
    throw new Error(
      'manifest.presentation.imageAsset must be a relative workspace path.',
    );
  }

  if (!displayName && !imageAsset) return undefined;
  return {
    ...(displayName ? { displayName } : {}),
    ...(imageAsset ? { imageAsset } : {}),
  };
}

function normalizeBundledDirectoryNames(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of directory names.`);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (!normalized) continue;
    if (
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized === '.' ||
      normalized === '..'
    ) {
      throw new Error(
        `${label} entry "${normalized}" must be a single directory name.`,
      );
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeSkillExternalRefs(
  value: unknown,
): ClawSkillExternalRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('manifest.skills.external must be an array.');
  }

  const out: ClawSkillExternalRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error('manifest.skills.external entries must be objects.');
    }
    const kind = normalizeString(entry.kind);
    if (kind !== 'git') {
      throw new Error(`Unsupported skill external kind "${kind}".`);
    }
    const ref = normalizeString(entry.ref);
    if (!ref) {
      throw new Error('manifest.skills.external entries require `ref`.');
    }
    const name = normalizeString(entry.name);
    out.push({
      kind,
      ref,
      ...(name ? { name } : {}),
    });
  }
  return out;
}

function normalizeSkillImportRefs(
  value: unknown,
): ClawSkillImportRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('manifest.skills.imports must be an array.');
  }

  const seen = new Set<string>();
  const out: ClawSkillImportRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error('manifest.skills.imports entries must be objects.');
    }
    const source = normalizeString(entry.source);
    if (!source) {
      throw new Error('manifest.skills.imports entries require `source`.');
    }
    if (seen.has(source)) continue;
    seen.add(source);
    out.push({ source });
  }
  return out;
}

function normalizePluginExternalRefs(
  value: unknown,
): ClawPluginExternalRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('manifest.plugins.external must be an array.');
  }

  const out: ClawPluginExternalRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error('manifest.plugins.external entries must be objects.');
    }
    const kind = normalizeString(entry.kind);
    if (kind !== 'npm' && kind !== 'local') {
      throw new Error(`Unsupported plugin external kind "${kind}".`);
    }
    const ref = normalizeString(entry.ref);
    if (!ref) {
      throw new Error('manifest.plugins.external entries require `ref`.');
    }
    const id = normalizeString(entry.id);
    out.push({
      kind,
      ref,
      ...(id ? { id } : {}),
    });
  }
  return out;
}

function normalizePluginConfigList(
  value: unknown,
): ClawPluginConfigList | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('manifest.config.plugins.list must be an array.');
  }

  const seen = new Set<string>();
  const out: ClawPluginConfigList = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error('manifest.config.plugins.list entries must be objects.');
    }
    const id = normalizeString(entry.id);
    if (!id) {
      throw new Error('manifest.config.plugins.list entries require `id`.');
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      enabled: entry.enabled !== false,
      ...(isRecord(entry.config) ? { config: { ...entry.config } } : {}),
    });
  }
  return out;
}

function listBundledArchiveDirectories(
  archiveEntries: string[],
  prefix: 'skills' | 'plugins',
): string[] {
  const discovered = new Set<string>();
  for (const entry of archiveEntries) {
    const normalized = entry.replace(/\\/g, '/');
    if (!normalized.startsWith(`${prefix}/`)) continue;
    const remainder = normalized.slice(prefix.length + 1);
    const [dirName] = remainder.split('/');
    if (dirName) discovered.add(dirName);
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

function validateBundledArchiveDirectories(
  archiveEntries: string[] | undefined,
  prefix: 'skills' | 'plugins',
  declared: string[] | undefined,
): void {
  if (!archiveEntries) return;

  const actual = listBundledArchiveDirectories(archiveEntries, prefix);
  const expected = [...(declared ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  if (actual.length !== expected.length) {
    throw new Error(
      `manifest.${prefix}.bundled does not match the ${prefix}/ entries in the archive.`,
    );
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `manifest.${prefix}.bundled does not match the ${prefix}/ entries in the archive.`,
      );
    }
  }
}

export function sanitizeClawAgentId(value: string, fallback = 'agent'): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return normalized || fallback;
}

export function validateClawManifest(
  input: unknown,
  options: ValidateClawManifestOptions = {},
): ClawManifest {
  if (!isRecord(input)) {
    throw new Error('manifest.json must contain a JSON object.');
  }

  if (input.formatVersion !== CLAW_FORMAT_VERSION) {
    throw new Error(
      `Unsupported .claw formatVersion "${String(input.formatVersion ?? '')}".`,
    );
  }

  const name = normalizeString(input.name);
  if (!name) {
    throw new Error('manifest.json is missing `name`.');
  }

  const id = normalizeString(input.id);
  const description = normalizeString(input.description);
  const author = normalizeString(input.author);
  const version = normalizeString(input.version);
  const createdAt = normalizeString(input.createdAt);
  if (createdAt && Number.isNaN(Date.parse(createdAt))) {
    throw new Error('manifest.json `createdAt` must be a valid ISO timestamp.');
  }
  const presentation = normalizePresentation(input.presentation);

  let agent: ClawManifest['agent'] | undefined;
  if (isRecord(input.agent)) {
    const model = normalizeModelConfig(input.agent.model);
    agent = {
      ...(model ? { model } : {}),
      ...(typeof input.agent.enableRag === 'boolean'
        ? { enableRag: input.agent.enableRag }
        : {}),
    };
  }

  let skills: ClawManifest['skills'] | undefined;
  if (isRecord(input.skills)) {
    const bundled = normalizeBundledDirectoryNames(
      input.skills.bundled,
      'manifest.skills.bundled',
    );
    const imports = normalizeSkillImportRefs(input.skills.imports);
    const external = normalizeSkillExternalRefs(input.skills.external);
    skills = {
      ...(bundled ? { bundled } : {}),
      ...(imports ? { imports } : {}),
      ...(external ? { external } : {}),
    };
  }

  let plugins: ClawManifest['plugins'] | undefined;
  if (isRecord(input.plugins)) {
    const bundled = normalizeBundledDirectoryNames(
      input.plugins.bundled,
      'manifest.plugins.bundled',
    );
    const external = normalizePluginExternalRefs(input.plugins.external);
    plugins = {
      ...(bundled ? { bundled } : {}),
      ...(external ? { external } : {}),
    };
  }

  let config: ClawManifest['config'] | undefined;
  if (isRecord(input.config)) {
    const skillConfig = isRecord(input.config.skills)
      ? (() => {
          const disabled = normalizeStringArray(input.config.skills.disabled);
          return {
            ...(disabled.length > 0 ? { disabled } : {}),
          };
        })()
      : undefined;
    const pluginConfig = isRecord(input.config.plugins)
      ? (() => {
          const list = normalizePluginConfigList(input.config.plugins.list);
          return {
            ...(list ? { list } : {}),
          };
        })()
      : undefined;

    config = {
      ...(skillConfig ? { skills: skillConfig } : {}),
      ...(pluginConfig ? { plugins: pluginConfig } : {}),
    };
  }

  validateBundledArchiveDirectories(
    options.archiveEntries,
    'skills',
    skills?.bundled,
  );
  validateBundledArchiveDirectories(
    options.archiveEntries,
    'plugins',
    plugins?.bundled,
  );

  return {
    formatVersion: CLAW_FORMAT_VERSION,
    name,
    ...(id ? { id } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(version ? { version } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(presentation ? { presentation } : {}),
    ...(agent && Object.keys(agent).length > 0 ? { agent } : {}),
    ...(skills && Object.keys(skills).length > 0 ? { skills } : {}),
    ...(plugins && Object.keys(plugins).length > 0 ? { plugins } : {}),
    ...(config && Object.keys(config).length > 0 ? { config } : {}),
  };
}
