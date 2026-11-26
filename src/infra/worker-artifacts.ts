/**
 * Worker output paths — maps paths a worker reports (artifacts, browser
 * frames, slide-sample images) to host paths inside its workspace.
 *
 * A path that resolves outside the workspace is dropped, never passed on, so a
 * worker cannot point the gateway at other host files. Workers report either
 * container paths (`/workspace/...`, the display root) or host paths; both
 * modes go through here. NOT the tool-side path guard: this only filters what
 * the gateway reads back after a turn.
 */
import path from 'node:path';
import { redactCredentialSecrets } from '../security/redact.js';
import type { ContainerOutput } from '../types/container.js';
import type {
  ArtifactMetadata,
  BrowserFrame,
  SlideSamples,
} from '../types/execution.js';
import {
  parseBrowserFrameLine,
  parseSlideSamplesLine,
} from './tool-progress-parser.js';

const CONTAINER_WORKSPACE_ROOT = '/workspace';

function isWithinResolvedRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveArtifactHostPath(
  rawPath: string,
  workspacePath: string,
  workspaceDisplayRoot = CONTAINER_WORKSPACE_ROOT,
): string | null {
  const input = String(rawPath || '').trim();
  if (!input) return null;
  const normalized = input.replace(/\\/g, '/');
  const workspaceRoot = path.resolve(workspacePath);
  const displayRoot = path.posix.normalize(
    String(workspaceDisplayRoot || '').trim() || CONTAINER_WORKSPACE_ROOT,
  );

  if (path.posix.isAbsolute(normalized)) {
    const resolvedActual = path.resolve(normalized);
    if (isWithinResolvedRoot(resolvedActual, workspaceRoot)) {
      return resolvedActual;
    }

    const cleanAbs = path.posix.normalize(normalized);
    const allowedRoots =
      displayRoot === CONTAINER_WORKSPACE_ROOT
        ? [CONTAINER_WORKSPACE_ROOT]
        : [CONTAINER_WORKSPACE_ROOT, displayRoot].sort(
            (left, right) => right.length - left.length,
          );
    const matchedRoot =
      allowedRoots.find(
        (root) => cleanAbs === root || cleanAbs.startsWith(`${root}/`),
      ) ?? null;
    if (!matchedRoot) {
      return null;
    }
    const rel = cleanAbs.slice(matchedRoot.length).replace(/^\/+/, '');
    const resolved = path.resolve(workspaceRoot, rel);
    if (isWithinResolvedRoot(resolved, workspaceRoot)) {
      return resolved;
    }
    return null;
  }

  const cleanRel = path.posix.normalize(normalized);
  if (cleanRel === '..' || cleanRel.startsWith('../')) return null;
  const resolved = path.resolve(workspaceRoot, cleanRel);
  if (isWithinResolvedRoot(resolved, workspaceRoot)) {
    return resolved;
  }
  return null;
}

export function remapOutputArtifacts(
  output: ContainerOutput,
  workspacePath: string,
  workspaceDisplayRoot?: string,
): void {
  if (!Array.isArray(output.artifacts) || output.artifacts.length === 0) return;
  const mapped: ArtifactMetadata[] = [];
  for (const artifact of output.artifacts) {
    const raw = artifact as Partial<ArtifactMetadata>;
    const hostPath = resolveArtifactHostPath(
      String(raw.path || ''),
      workspacePath,
      workspaceDisplayRoot,
    );
    if (!hostPath) continue;
    const filename =
      String(raw.filename || '').trim() || path.basename(hostPath);
    const mimeType =
      String(raw.mimeType || '').trim() || 'application/octet-stream';
    mapped.push({ path: hostPath, filename, mimeType });
  }
  if (mapped.length === 0) {
    delete output.artifacts;
    return;
  }
  output.artifacts = mapped;
}

/** Pool-entry state for the side lines (`[browser-frame]`, `[slide-samples]`) that precede a result. */
export interface BrowserFrameSink {
  pendingBrowserFrame?: BrowserFrame;
  pendingSlideSamples?: SlideSamples;
  browserFrameWorkspace?: { path: string; displayRoot?: string };
}

/** Keep a `[browser-frame]` line for the next browser result; true if it was one. */
export function stashBrowserFrameLine(
  entry: BrowserFrameSink,
  line: string,
): boolean {
  const frame = parseBrowserFrameLine(line);
  if (!frame) return false;
  const workspace = entry.browserFrameWorkspace;
  const hostPath =
    frame.frame && workspace
      ? resolveArtifactHostPath(
          frame.frame,
          workspace.path,
          workspace.displayRoot,
        )
      : null;
  entry.pendingBrowserFrame = {
    url: redactCredentialSecrets(frame.url),
    title: redactCredentialSecrets(frame.title),
    ...(hostPath ? { frame: hostPath } : {}),
    ...(frame.signIn ? { signIn: frame.signIn } : {}),
    ...(frame.paymentCard ? { paymentCard: frame.paymentCard } : {}),
  };
  return true;
}

/** Keep a `[slide-samples]` line for the tool's result; true if it was one. */
export function stashSlideSamplesLine(
  entry: BrowserFrameSink,
  line: string,
): boolean {
  const samples = parseSlideSamplesLine(line);
  if (!samples) return false;
  const workspace = entry.browserFrameWorkspace;
  const looks = workspace
    ? samples.looks.flatMap((look) => {
        const image = resolveArtifactHostPath(
          look.image,
          workspace.path,
          workspace.displayRoot,
        );
        return image ? [{ ...look, image }] : [];
      })
    : [];
  // A picture that doesn't resolve would leave a look the user can't see.
  entry.pendingSlideSamples =
    looks.length === samples.looks.length ? { ...samples, looks } : undefined;
  return true;
}

export function takeSlideSamples(
  entry: BrowserFrameSink,
  toolName: string,
  phase: 'start' | 'finish',
): SlideSamples | undefined {
  if (phase !== 'finish' || toolName !== 'show_slide_samples') return undefined;
  const samples = entry.pendingSlideSamples;
  entry.pendingSlideSamples = undefined;
  return samples;
}

export function takeBrowserFrame(
  entry: BrowserFrameSink,
  toolName: string,
  phase: 'start' | 'finish',
): BrowserFrame | undefined {
  if (phase !== 'finish' || !toolName.startsWith('browser_')) return undefined;
  const frame = entry.pendingBrowserFrame;
  entry.pendingBrowserFrame = undefined;
  return frame;
}
