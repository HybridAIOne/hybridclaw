/**
 * Vision file references resolve identically for execution and batch ordering.
 * Unlike the image loader, this identifies paths without reading image bytes;
 * it neither grants permission nor fetches remote images.
 */
import os from 'node:os';
import path from 'node:path';
import { readString } from '@hybridclaw/shared/primitive-values';
import { resolveHttpArtifactReadPath } from './http-artifact-read-path.js';
import { resolveMediaPath, resolveWorkspacePath } from './runtime-paths.js';

const VISION_LOCAL_SCRATCH_ROOTS = Array.from(
  new Set(
    ['/tmp', '/private/tmp', os.tmpdir()].map((entry) => path.resolve(entry)),
  ),
);

function extractArtifactUrlLocalPath(rawPath: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawPath, 'http://hybridclaw.invalid');
  } catch {
    return null;
  }
  if (parsed.pathname !== '/api/artifact') return null;
  const pathParam = parsed.searchParams.get('path');
  return pathParam ? pathParam.trim() : null;
}

export function normalizeVisionLocalPath(rawPath: string): string | null {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return null;
  const normalized = extractArtifactUrlLocalPath(trimmed) || trimmed;

  const artifactPath = resolveHttpArtifactReadPath(normalized);
  if (artifactPath) return artifactPath;
  const workspacePath = resolveWorkspacePath(normalized);
  if (workspacePath) return workspacePath;

  const mediaPath = resolveMediaPath(normalized);
  if (mediaPath) return mediaPath;

  const resolved = path.resolve(normalized);
  for (const root of VISION_LOCAL_SCRATCH_ROOTS) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      return resolved;
    }
  }

  return null;
}

export function visionImageSources(args: Record<string, unknown>): {
  imageRef: string;
  fallbackUrl: string;
} {
  return {
    imageRef:
      readString(args.image_url) ||
      readString(args.imageUrl) ||
      readString(args.path),
    fallbackUrl:
      readString(args.fallback_url) ||
      readString(args.fallbackUrl) ||
      readString(args.original_url),
  };
}
