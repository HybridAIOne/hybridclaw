import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_WORKSPACE_ROOT_DISPLAY = '/workspace';
function normalizeDisplayRoot(rawValue: string | undefined): string {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return DEFAULT_WORKSPACE_ROOT_DISPLAY;
  const normalized = normalizeSlashes(trimmed);
  if (!path.posix.isAbsolute(normalized)) {
    return DEFAULT_WORKSPACE_ROOT_DISPLAY;
  }
  return path.posix.normalize(normalized);
}

export const WORKSPACE_ROOT_DISPLAY = normalizeDisplayRoot(
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT,
);
export const DISCORD_MEDIA_CACHE_ROOT_DISPLAY = '/discord-media-cache';
export const UPLOADED_MEDIA_CACHE_ROOT_DISPLAY = '/uploaded-media-cache';
const MANAGED_TEMP_MEDIA_DIR_PREFIXES = ['hybridclaw-wa-'] as const;

export const WORKSPACE_ROOT = path.resolve(
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT || WORKSPACE_ROOT_DISPLAY,
);
const ALLOWED_HOST_ROOTS = (() => {
  const raw = (process.env.HYBRIDCLAW_AGENT_ALLOWED_ROOTS || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => expandUserPath(value))
      .filter(Boolean)
      .map((value) => path.resolve(value));
  } catch {
    return [];
  }
})();
export const DISCORD_MEDIA_CACHE_ROOT = path.resolve(
  process.env.HYBRIDCLAW_AGENT_MEDIA_ROOT || DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
);
export const UPLOADED_MEDIA_CACHE_ROOT = path.resolve(
  process.env.HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT ||
    UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
);
export const IPC_DIR = path.resolve(
  process.env.HYBRIDCLAW_AGENT_IPC_DIR || '/ipc',
);

interface ExtraMountAlias {
  hostPaths: string[];
  containerPath: string;
  readonly: boolean;
}

function loadExtraMountAliases(): ExtraMountAlias[] {
  const raw = (process.env.HYBRIDCLAW_AGENT_EXTRA_MOUNTS || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const mount = entry as Partial<ExtraMountAlias>;
        const hostPaths = Array.isArray(mount.hostPaths)
          ? mount.hostPaths
              .filter((value): value is string => typeof value === 'string')
              .map((value) => value.trim())
              .filter(Boolean)
          : [];
        const containerPath =
          typeof mount.containerPath === 'string'
            ? mount.containerPath.trim()
            : '';
        if (hostPaths.length === 0 || !containerPath) return null;
        return {
          hostPaths,
          containerPath,
          readonly: mount.readonly !== false,
        };
      })
      .filter((value): value is ExtraMountAlias => value !== null);
  } catch {
    return [];
  }
}

const EXTRA_MOUNT_ALIASES = loadExtraMountAliases();

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function resolveCanonicalPath(rawPath: string): string {
  try {
    return fs.realpathSync.native(rawPath);
  } catch {
    try {
      return fs.realpathSync(rawPath);
    } catch {
      return path.resolve(rawPath);
    }
  }
}

function resolveManagedTempMediaPath(rawPath: string): string | null {
  const input = String(rawPath || '').trim();
  if (!input || !path.isAbsolute(input)) return null;

  const candidate = resolveCanonicalPath(input);
  const tempRoot = resolveCanonicalPath(os.tmpdir());
  if (!isWithinRoot(candidate, tempRoot)) return null;

  const dirName = path.basename(path.dirname(candidate));
  if (
    !MANAGED_TEMP_MEDIA_DIR_PREFIXES.some((prefix) =>
      dirName.startsWith(prefix),
    )
  ) {
    return null;
  }

  return candidate;
}

function resolveDisplayAbsoluteToActual(
  normalizedInput: string,
  displayRoot: string,
  actualRoot: string,
): string | null {
  const normalizedDisplayRoot = path.posix.normalize(displayRoot);
  if (
    normalizedInput !== normalizedDisplayRoot &&
    !normalizedInput.startsWith(`${normalizedDisplayRoot}/`)
  ) {
    return null;
  }

  const relative = normalizedInput
    .slice(normalizedDisplayRoot.length)
    .replace(/^\/+/, '');
  return relative
    ? path.resolve(actualRoot, relative)
    : path.resolve(actualRoot);
}

function resolveRootBoundPath(
  rawPath: string,
  actualRoot: string,
  displayRoot: string,
): string | null {
  const input = expandUserPath(String(rawPath || ''));
  if (!input) return null;

  const normalizedInput = normalizeSlashes(input);
  if (path.posix.isAbsolute(normalizedInput)) {
    const fromExtraMount = resolveExtraMountPath(normalizedInput, actualRoot);
    if (fromExtraMount) return fromExtraMount;

    const fromDisplay = resolveDisplayAbsoluteToActual(
      path.posix.normalize(normalizedInput),
      displayRoot,
      actualRoot,
    );
    if (fromDisplay) {
      return isWithinRoot(fromDisplay, actualRoot) ? fromDisplay : null;
    }

    const resolvedActual = path.resolve(input);
    if (ALLOWED_HOST_ROOTS.some((root) => isWithinRoot(resolvedActual, root))) {
      return resolvedActual;
    }
    return isWithinRoot(resolvedActual, actualRoot) ? resolvedActual : null;
  }

  let clean = path.posix.normalize(normalizedInput);
  const displayBaseName = path.posix.basename(displayRoot);
  if (
    displayRoot !== DEFAULT_WORKSPACE_ROOT_DISPLAY &&
    displayBaseName &&
    displayBaseName !== '.' &&
    displayBaseName !== '/' &&
    (clean === displayBaseName || clean.startsWith(`${displayBaseName}/`))
  ) {
    clean = clean === displayBaseName ? '.' : clean.slice(displayBaseName.length + 1);
  }
  if (clean === '..' || clean.startsWith('../')) return null;
  const resolved = path.resolve(actualRoot, clean);
  return isWithinRoot(resolved, actualRoot) ? resolved : null;
}

function resolveExtraMountPath(
  normalizedAbsolutePath: string,
  actualRoot: string,
): string | null {
  const resolvedInput = path.resolve(normalizedAbsolutePath);

  for (const mount of EXTRA_MOUNT_ALIASES) {
    for (const hostPath of mount.hostPaths) {
      const resolvedHostPath = path.resolve(hostPath);
      const relative = path.relative(resolvedHostPath, resolvedInput);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        continue;
      }

      const mapped = relative
        ? path.resolve(mount.containerPath, relative)
        : path.resolve(mount.containerPath);
      if (isWithinRoot(mapped, actualRoot)) return mapped;
    }
  }

  return null;
}

export function resolveWorkspacePath(rawPath: string): string | null {
  return resolveRootBoundPath(rawPath, WORKSPACE_ROOT, WORKSPACE_ROOT_DISPLAY);
}

export function resolveWorkspaceGlobPattern(rawPattern: string): string | null {
  const input = expandUserPath(String(rawPattern || ''));
  if (!input) return null;

  const normalized = normalizeSlashes(input);
  const firstMeta = normalized.search(/[*?[{]/);
  if (firstMeta === -1) return resolveWorkspacePath(input);

  if (!path.posix.isAbsolute(normalized)) {
    const clean = path.posix.normalize(normalized);
    if (clean === '..' || clean.startsWith('../')) return null;
    return path.resolve(WORKSPACE_ROOT, clean);
  }

  const prefixEnd = normalized.lastIndexOf('/', firstMeta);
  if (prefixEnd <= 0) return null;
  const prefix = normalized.slice(0, prefixEnd);
  const suffix = normalized.slice(prefixEnd);
  const resolvedPrefix = resolveWorkspacePath(prefix);
  if (!resolvedPrefix) return null;
  return `${resolvedPrefix.replace(/\\/g, '/')}${suffix}`;
}

export function resolveMediaPath(rawPath: string): string | null {
  return (
    resolveManagedTempMediaPath(rawPath) ||
    resolveRootBoundPath(
      rawPath,
      DISCORD_MEDIA_CACHE_ROOT,
      DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
    ) ||
    resolveRootBoundPath(
      rawPath,
      UPLOADED_MEDIA_CACHE_ROOT,
      UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
    )
  );
}

export function toWorkspaceRelativePath(rawPath: string): string | null {
  const resolved = resolveWorkspacePath(rawPath);
  if (!resolved) return null;
  return path.relative(WORKSPACE_ROOT, resolved).replace(/\\/g, '/');
}

function stripRootPrefix(value: string, root: string): string {
  const normalizedValue = normalizeSlashes(value);
  const normalizedRoot = normalizeSlashes(root).replace(/\/+$/, '');
  if (normalizedValue === normalizedRoot) return '';
  if (normalizedValue.startsWith(`${normalizedRoot}/`)) {
    return normalizedValue.slice(normalizedRoot.length + 1);
  }
  return value;
}

export function stripWorkspaceRootPrefix(rawPath: string): string {
  const strippedDisplay = stripRootPrefix(rawPath, WORKSPACE_ROOT_DISPLAY);
  return stripRootPrefix(strippedDisplay, WORKSPACE_ROOT);
}

export function replaceWorkspaceRootInOutput(text: string): string {
  return text
    .replaceAll(`${WORKSPACE_ROOT.replace(/\\/g, '/')}/`, '')
    .replaceAll(`${WORKSPACE_ROOT_DISPLAY}/`, '');
}
