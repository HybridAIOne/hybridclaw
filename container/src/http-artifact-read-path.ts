/**
 * Gateway HTTP artifact aliases address files in the authoritative state root.
 * Unlike workspace paths, these aliases never select execution-project files;
 * they authorize no writes, directory traversal, links or additional roots.
 */
import path from 'node:path';
import {
  HTTP_RESPONSE_ARTIFACT_DIR,
  HTTP_RESPONSE_ARTIFACT_PREFIX,
} from '../shared/http-response-artifacts.js';
import {
  resolveCanonicalPath,
  resolveWorkspacePath,
  WORKSPACE_STATE_ROOT,
} from './runtime-paths.js';

export function resolveHttpArtifactReadPath(rawPath: string): string | null {
  if (!rawPath.startsWith(HTTP_RESPONSE_ARTIFACT_PREFIX)) return null;
  const filename = rawPath.slice(HTTP_RESPONSE_ARTIFACT_PREFIX.length);
  if (
    !filename ||
    filename === '.' ||
    filename === '..' ||
    /[\\/\0]/.test(filename)
  ) {
    throw new Error('HTTP artifact aliases require a single filename');
  }
  const canonical = path.join(
    resolveCanonicalPath(WORKSPACE_STATE_ROOT),
    HTTP_RESPONSE_ARTIFACT_DIR,
    filename,
  );
  if (resolveCanonicalPath(canonical) !== canonical) {
    throw new Error('HTTP artifact aliases cannot follow links');
  }
  const resolved = resolveWorkspacePath(
    path.join(WORKSPACE_STATE_ROOT, HTTP_RESPONSE_ARTIFACT_DIR, filename),
  );
  if (!resolved) throw new Error('HTTP artifact is outside allowed roots');
  return resolved;
}
