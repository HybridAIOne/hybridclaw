/**
 * Result-text artifact recovery — turns workspace files the final assistant
 * reply points at into attachments the channel can deliver.
 *
 * Only existing files inside the agent workspace are returned; a path that
 * escapes it is dropped. Three signals, strongest first: a document the turn
 * wrote with `write`/`edit` and the reply names; a binary deliverable the
 * reply mentions; a text document the reply links to. A text document that is
 * merely mentioned is not enough, because replies routinely name bootstrap
 * files such as MEMORY.md without meaning to send them.
 *
 * NOT the container's end-of-turn discovery (`container/src/artifacts.ts`),
 * which attaches new binary files whether or not the reply mentions them.
 */

import path from 'node:path';
import type { ArtifactMetadata, ToolExecution } from '../types/execution.js';
import { WORKSPACE_BOOTSTRAP_FILES } from '../workspace.js';
import {
  extensionToMimeType,
  resolveWorkspaceRelativePath,
} from './gateway-utils.js';

const GENERATED_MEDIA_ARTIFACT_RE =
  /(?:\/workspace\/|\.\/)?(\.generated-(?:images|videos)\/[A-Za-z0-9._@%+=-]+\.(?:png|jpe?g|gif|webp|svg|mp4|m4v|mov|webm))/gi;
const REFERENCED_WORKSPACE_ARTIFACT_RE =
  /(?:\/workspace\/|\.\/)?([\p{L}\p{N}._@%+=-]+(?:\/[\p{L}\p{N}._@%+= -]+)*\.(?:docx|gif|jpe?g|m4a|m4v|mov|mp3|mp4|ogg|pdf|png|pptx|svg|wav|webm|webp|xlsx))/giu;
const TEXT_DOCUMENT_EXTENSIONS = ['csv', 'html', 'json', 'md', 'tsv', 'txt'];
const LINKED_WORKSPACE_DOCUMENT_RE = new RegExp(
  String.raw`\]\(\s*<?(?:sandbox:|file:\/\/)?(?:\/workspace\/|\.\/)?([\p{L}\p{N}._@%+=-]+(?:\/[\p{L}\p{N}._@%+= -]+)*\.(?:${TEXT_DOCUMENT_EXTENSIONS.join('|')}))>?\s*\)`,
  'giu',
);
const WRITTEN_DELIVERABLE_EXTENSIONS = new Set([
  ...TEXT_DOCUMENT_EXTENSIONS,
  'docx',
  'pdf',
  'pptx',
  'svg',
  'xlsx',
]);
const FILE_WRITE_TOOL_NAMES = new Set(['write', 'edit']);
const BOOTSTRAP_FILE_NAMES = new Set<string>(WORKSPACE_BOOTSTRAP_FILES);

function isGeneratedMediaPath(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return (
    parts.includes('.generated-images') || parts.includes('.generated-videos')
  );
}

function normalizeArtifactTextPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function workspacePrefix(workspacePath: string): string {
  return `${normalizeArtifactTextPath(path.resolve(workspacePath))}/`;
}

function decodeArtifactTextVariants(
  resultText: string,
  workspacePath: string,
): string[] {
  const variants = [resultText];
  try {
    // Web chat artifact URLs encode path separators; recover those when the
    // model copies an `/api/artifact?path=...` URL into final text.
    const decoded = decodeURIComponent(resultText);
    if (decoded !== resultText) variants.push(decoded);
  } catch {
    // Leave malformed percent escapes untouched.
  }
  // Host-sandbox agents see their workspace at its real path, so replies link
  // to `/Users/.../workspace/report.md`; map that onto `/workspace/`.
  const prefix = workspacePrefix(workspacePath);
  for (const variant of [...variants]) {
    const normalized = normalizeArtifactTextPath(variant);
    if (normalized.includes(prefix)) {
      variants.push(normalized.split(prefix).join('/workspace/'));
    }
  }
  return variants;
}

function extractWorkspaceReferences(params: {
  textVariants: string[];
  workspacePath: string;
  pattern: RegExp;
}): Array<{ filePath: string; filename: string }> {
  const references: Array<{ filePath: string; filename: string }> = [];
  const seen = new Set<string>();
  for (const textVariant of params.textVariants) {
    for (const match of textVariant.matchAll(params.pattern)) {
      const relativePath = match[1];
      if (!relativePath) continue;
      const filePath = resolveWorkspaceRelativePath(
        params.workspacePath,
        relativePath,
      );
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      references.push({
        filePath,
        filename: path.basename(filePath),
      });
    }
  }
  return references;
}

function parseToolPathArgument(argumentsJson: string): string | null {
  try {
    const parsed = JSON.parse(argumentsJson) as { path?: unknown };
    return typeof parsed.path === 'string' ? parsed.path : null;
  } catch {
    return null;
  }
}

function resolveWrittenDeliverable(
  workspacePath: string,
  rawPath: string,
): string | null {
  let relativePath = normalizeArtifactTextPath(rawPath.trim());
  const prefix = workspacePrefix(workspacePath);
  if (relativePath.startsWith(prefix)) {
    relativePath = relativePath.slice(prefix.length);
  } else if (relativePath.startsWith('/workspace/')) {
    relativePath = relativePath.slice('/workspace/'.length);
  }
  relativePath = relativePath.replace(/^(?:\.\/)+/, '');
  const segments = relativePath.split('/');
  if (
    segments.some((segment) => segment.startsWith('.')) ||
    (segments.length === 1 && BOOTSTRAP_FILE_NAMES.has(relativePath)) ||
    segments[0] === 'memory' ||
    !WRITTEN_DELIVERABLE_EXTENSIONS.has(
      path.extname(relativePath).slice(1).toLowerCase(),
    )
  ) {
    return null;
  }
  return resolveWorkspaceRelativePath(workspacePath, relativePath);
}

function textNamesFile(textVariants: string[], filename: string): boolean {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `list.md` must not match inside `checklist.md`, `list.mdx`, or
  // `list.md.bak`; a trailing sentence period still counts.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}._-])${escaped}(?!\\.?[\\p{L}\\p{N}_-])`,
    'u',
  );
  return textVariants.some((variant) => pattern.test(variant));
}

function extractWrittenDeliverables(params: {
  textVariants: string[];
  workspacePath: string;
  toolExecutions: ToolExecution[];
}): Array<{ filePath: string; filename: string }> {
  const references: Array<{ filePath: string; filename: string }> = [];
  const seen = new Set<string>();
  for (const execution of params.toolExecutions) {
    if (!FILE_WRITE_TOOL_NAMES.has(execution.name) || execution.isError) {
      continue;
    }
    const rawPath = parseToolPathArgument(execution.arguments);
    const filePath =
      rawPath && resolveWrittenDeliverable(params.workspacePath, rawPath);
    if (!filePath || seen.has(filePath)) continue;
    const filename = path.basename(filePath);
    if (!textNamesFile(params.textVariants, filename)) continue;
    seen.add(filePath);
    references.push({ filePath, filename });
  }
  return references;
}

function artifactIsMentionedInText(params: {
  artifact: ArtifactMetadata;
  resultTextVariants: string[];
  workspacePath: string;
}): boolean {
  const mentionedValues = new Set<string>();
  const filename = params.artifact.filename.trim();
  if (filename) mentionedValues.add(filename);

  const artifactPath = normalizeArtifactTextPath(params.artifact.path);
  if (artifactPath) mentionedValues.add(artifactPath);

  const relativePath = normalizeArtifactTextPath(
    path.relative(params.workspacePath, params.artifact.path),
  );
  if (
    relativePath &&
    relativePath !== '..' &&
    !relativePath.startsWith('../')
  ) {
    mentionedValues.add(relativePath);
    mentionedValues.add(`./${relativePath}`);
    mentionedValues.add(`/workspace/${relativePath}`);
  }

  for (const textVariant of params.resultTextVariants) {
    const normalizedText = normalizeArtifactTextPath(textVariant);
    for (const value of mentionedValues) {
      if (value && normalizedText.includes(value)) return true;
    }
  }
  return false;
}

export function recoverGeneratedMediaArtifactsFromResultText(params: {
  resultText: string;
  workspacePath: string;
  artifacts?: ArtifactMetadata[];
  toolExecutions?: ToolExecution[];
}): ArtifactMetadata[] | undefined {
  const existing = Array.isArray(params.artifacts) ? params.artifacts : [];
  const recovered = [...existing];
  const seen = new Set(existing.map((artifact) => artifact.path));
  const resultTextVariants = decodeArtifactTextVariants(
    params.resultText,
    params.workspacePath,
  );
  const references = [
    ...extractWrittenDeliverables({
      textVariants: resultTextVariants,
      workspacePath: params.workspacePath,
      toolExecutions: params.toolExecutions ?? [],
    }),
    ...[
      GENERATED_MEDIA_ARTIFACT_RE,
      REFERENCED_WORKSPACE_ARTIFACT_RE,
      LINKED_WORKSPACE_DOCUMENT_RE,
    ].flatMap((pattern) =>
      extractWorkspaceReferences({
        textVariants: resultTextVariants,
        workspacePath: params.workspacePath,
        pattern,
      }),
    ),
  ];
  for (const reference of references) {
    if (seen.has(reference.filePath)) continue;
    seen.add(reference.filePath);
    recovered.push({
      path: reference.filePath,
      filename: reference.filename,
      mimeType: extensionToMimeType(path.extname(reference.filename)),
    });
  }
  if (recovered.length > 1) {
    const mentionedGeneratedArtifacts = new Set(
      recovered
        .filter(
          (artifact) =>
            isGeneratedMediaPath(artifact.path) &&
            artifactIsMentionedInText({
              artifact,
              resultTextVariants,
              workspacePath: params.workspacePath,
            }),
        )
        .map((artifact) => path.resolve(artifact.path)),
    );
    if (mentionedGeneratedArtifacts.size === 0) {
      return recovered;
    }
    return recovered.filter((artifact) => {
      if (!isGeneratedMediaPath(artifact.path)) return true;
      return mentionedGeneratedArtifacts.has(path.resolve(artifact.path));
    });
  }
  return recovered.length > 0 ? recovered : undefined;
}
