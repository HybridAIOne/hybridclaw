/**
 * Installer recipes retain platform restrictions even when malformed (deny all).
 * Unlike the catalog, this module only normalizes dependency recipes; it never
 * discovers skills or executes installers. Repeated ids describe alternatives.
 */
import YAML from 'yaml';
import { isRecord } from '../utils/type-guards.js';

export type SkillInstallKind =
  | 'brew'
  | 'uv'
  | 'npm'
  | 'node'
  | 'go'
  | 'download';

export interface SkillInstallSpec {
  id?: string;
  kind: SkillInstallKind;
  os?: string[];
  arch?: string[];
  label?: string;
  bins?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  path?: string;
  chmod?: string;
}

function normalizeConstraint(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.some((value) => typeof value !== 'string' || !value.trim())
  )
    return [];
  return raw.map((value: string) => value.trim());
}

export function normalizeInstallSpecs(
  raw: unknown,
  normalizeStringList: (raw: unknown) => string[],
): SkillInstallSpec[] {
  if (!Array.isArray(raw)) return [];

  const specs: SkillInstallSpec[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const kindRaw =
      typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : '';
    if (
      kindRaw !== 'brew' &&
      kindRaw !== 'uv' &&
      kindRaw !== 'npm' &&
      kindRaw !== 'node' &&
      kindRaw !== 'go' &&
      kindRaw !== 'download'
    ) {
      continue;
    }

    specs.push({
      id: typeof entry.id === 'string' ? entry.id.trim() : undefined,
      kind: kindRaw,
      os: normalizeConstraint(entry.os),
      arch: normalizeConstraint(entry.arch),
      label: typeof entry.label === 'string' ? entry.label.trim() : undefined,
      bins: normalizeStringList(entry.bins),
      formula:
        typeof entry.formula === 'string' ? entry.formula.trim() : undefined,
      package:
        typeof entry.package === 'string' ? entry.package.trim() : undefined,
      module:
        typeof entry.module === 'string' ? entry.module.trim() : undefined,
      url: typeof entry.url === 'string' ? entry.url.trim() : undefined,
      path: typeof entry.path === 'string' ? entry.path.trim() : undefined,
      chmod: typeof entry.chmod === 'string' ? entry.chmod.trim() : undefined,
    });
  }
  return specs;
}

export function parseInstallSpecList(raw: string): unknown {
  try {
    return YAML.parse(raw);
  } catch {
    return [];
  }
}
