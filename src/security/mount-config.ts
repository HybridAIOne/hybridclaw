import path from 'node:path';

import type { RuntimeConfig } from '../config/runtime-config.js';
import type { AdditionalMount } from '../types/security.js';
import { expandHomePath } from '../utils/path.js';

export interface ConfiguredMountParseResult {
  mounts: AdditionalMount[];
  warnings: string[];
}

function expandUserPath(input: string): string {
  const expanded = expandHomePath(input);
  return expanded ? path.resolve(expanded) : '';
}

function normalizeMountKey(mount: AdditionalMount): string {
  return [
    expandUserPath(mount.hostPath),
    mount.containerPath || '',
    mount.readonly === false ? 'rw' : 'ro',
  ].join('::');
}

function dedupeMounts(mounts: AdditionalMount[]): AdditionalMount[] {
  const seen = new Set<string>();
  const deduped: AdditionalMount[] = [];
  for (const mount of mounts) {
    const key = normalizeMountKey(mount);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(mount);
  }
  return deduped;
}

function normalizeReadonly(rawMode: string | undefined): boolean | null {
  if (!rawMode) return true;
  const normalized = rawMode.trim().toLowerCase();
  if (normalized === 'ro') return true;
  if (normalized === 'rw') return false;
  return null;
}

function parseBindSpec(spec: string): {
  mount: AdditionalMount | null;
  warning?: string;
} {
  const raw = String(spec || '').trim();
  if (!raw) return { mount: null, warning: 'empty bind spec' };

  const parts = raw.split(':');
  if (parts.length < 2) {
    return {
      mount: null,
      warning:
        'bind spec must use host:container[:ro|rw] format (for example "/host/data:/data:ro")',
    };
  }

  const maybeMode = parts.at(-1)?.trim().toLowerCase();
  const readonly = normalizeReadonly(maybeMode);
  const hasExplicitMode = readonly !== null;
  const containerIndex = hasExplicitMode ? parts.length - 2 : parts.length - 1;
  const hostParts = parts.slice(0, containerIndex);
  const containerPath = parts[containerIndex]?.trim() || '';
  const hostPath = hostParts.join(':').trim();

  if (!hostPath || !containerPath) {
    return {
      mount: null,
      warning:
        'bind spec must include both a host path and container path (for example "/host/data:/data:ro")',
    };
  }

  if (containerPath === '/' || containerPath === '/workspace') {
    return {
      mount: null,
      warning: `bind spec "${raw}" targets a reserved container path`,
    };
  }

  return {
    mount: {
      hostPath,
      containerPath: containerPath.replace(/^\/+/, ''),
      readonly: hasExplicitMode ? readonly : true,
    },
  };
}

export function parseBindSpecs(specs: string[]): ConfiguredMountParseResult {
  const mounts: AdditionalMount[] = [];
  const warnings: string[] = [];

  for (const spec of specs) {
    const parsed = parseBindSpec(spec);
    if (parsed.mount) {
      mounts.push(parsed.mount);
    } else if (parsed.warning) {
      warnings.push(parsed.warning);
    }
  }

  return {
    mounts: dedupeMounts(mounts),
    warnings,
  };
}

export function resolveConfiguredAdditionalMounts(
  containerConfig: Pick<
    RuntimeConfig['container'],
    'binds' | 'additionalMounts'
  >,
): ConfiguredMountParseResult {
  const bindResult = parseBindSpecs(containerConfig.binds || []);
  return {
    mounts: bindResult.mounts,
    warnings: bindResult.warnings,
  };
}
