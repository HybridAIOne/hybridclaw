import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentWorkspaceDir } from '../infra/ipc.js';
import { normalizeOptionalTrimmedUniqueStringArray } from '../utils/normalized-strings.js';
import { ensureBootstrapFiles } from '../workspace.js';
import {
  getAgentById,
  getStoredAgentConfig,
  upsertRegisteredAgent,
} from './agent-registry.js';
import { activateAgentInRuntimeConfig } from './agent-runtime-config.js';
import {
  type AgentConfig,
  type AgentModelConfig,
  normalizeAgentCv,
  normalizeAgentEscalationTarget,
} from './agent-types.js';

const MARKDOWN_MAX_BYTES = 200_000;
const IMAGE_ASSET_MAX_BYTES = 5_000_000;
const IMAGE_ASSET_DIR = 'assets';
const IMAGE_EXTENSIONS = new Set([
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);
const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};
const TOP_LEVEL_MARKDOWN_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export interface ApplyAgentConfigJsonOptions {
  activate?: boolean;
}

export interface ApplyAgentConfigJsonResult {
  agent: AgentConfig;
  workspacePath: string;
  markdownFiles: string[];
  runtimeConfigChanged: boolean;
}

type AgentConfigJsonPayload = Record<string, unknown> & {
  agent?: unknown;
  files?: unknown;
  markdown?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeRequiredStringField(
  fieldName: string,
  value: unknown,
): string {
  if (typeof value !== 'string') {
    throw new Error(`\`${fieldName}\` must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Agent config JSON requires a non-empty \`${fieldName}\`.`);
  }
  return normalized;
}

function normalizeOptionalStringField(
  fieldName: string,
  value: unknown,
): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`\`${fieldName}\` must be a string or null.`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeOptionalStringArrayField(
  fieldName: string,
  value: unknown,
): string[] | undefined {
  if (value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`\`${fieldName}\` must be an array of strings or null.`);
  }
  if (value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`\`${fieldName}\` must be an array of strings or null.`);
  }
  return normalizeOptionalTrimmedUniqueStringArray(value);
}

function normalizeModelConfig(value: unknown): AgentModelConfig | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (!isRecord(value)) return undefined;

  const primary = normalizeOptionalString(value.primary);
  if (!primary) return undefined;
  const seen = new Set<string>([primary]);
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks
        .map(normalizeOptionalString)
        .filter((entry): entry is string => {
          if (!entry || seen.has(entry)) return false;
          seen.add(entry);
          return true;
        })
    : [];
  return fallbacks.length > 0 ? { primary, fallbacks } : { primary };
}

function parseAgentConfigJson(rawJson: string): AgentConfigJsonPayload {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('Agent config JSON must be an object.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid agent config JSON: ${error.message}`);
    }
    throw error;
  }
}

function resolveAgentConfigInput(
  payload: AgentConfigJsonPayload,
): Record<string, unknown> {
  if (payload.agent !== undefined) {
    if (!isRecord(payload.agent)) {
      throw new Error('`agent` must be an object when provided.');
    }
    return payload.agent;
  }
  return payload;
}

function applyAgentConfigFieldUpdates(
  base: AgentConfig,
  updates: Record<string, unknown>,
): AgentConfig {
  const id = Object.hasOwn(updates, 'id')
    ? normalizeRequiredStringField('id', updates.id)
    : base.id;

  const next: AgentConfig = { ...base, id };
  if (Object.hasOwn(updates, 'name')) {
    const name = normalizeOptionalStringField('name', updates.name);
    if (name) next.name = name;
    else delete next.name;
  }
  if (Object.hasOwn(updates, 'displayName')) {
    const displayName = normalizeOptionalStringField(
      'displayName',
      updates.displayName,
    );
    if (displayName) next.displayName = displayName;
    else delete next.displayName;
  }
  if (Object.hasOwn(updates, 'imageAsset')) {
    const imageAsset = normalizeOptionalStringField(
      'imageAsset',
      updates.imageAsset,
    );
    if (imageAsset) next.imageAsset = imageAsset;
    else delete next.imageAsset;
  }
  if (Object.hasOwn(updates, 'model')) {
    const model = normalizeModelConfig(updates.model);
    if (model) next.model = model;
    else delete next.model;
  }
  if (Object.hasOwn(updates, 'skills')) {
    const skills = normalizeOptionalStringArrayField('skills', updates.skills);
    if (skills !== undefined) next.skills = skills;
    else delete next.skills;
  }
  if (Object.hasOwn(updates, 'workspace')) {
    const workspace = normalizeOptionalStringField(
      'workspace',
      updates.workspace,
    );
    if (workspace) next.workspace = workspace;
    else delete next.workspace;
  }
  if (Object.hasOwn(updates, 'chatbotId')) {
    const chatbotId = normalizeOptionalStringField(
      'chatbotId',
      updates.chatbotId,
    );
    if (chatbotId) next.chatbotId = chatbotId;
    else delete next.chatbotId;
  }
  if (Object.hasOwn(updates, 'enableRag')) {
    if (typeof updates.enableRag === 'boolean') {
      next.enableRag = updates.enableRag;
    } else if (updates.enableRag === null) {
      delete next.enableRag;
    } else {
      throw new Error('`enableRag` must be a boolean or null.');
    }
  }
  if (Object.hasOwn(updates, 'role')) {
    const role = normalizeOptionalStringField('role', updates.role);
    if (role) next.role = role;
    else delete next.role;
  }
  const reportsToValue = Object.hasOwn(updates, 'reportsTo')
    ? updates.reportsTo
    : Object.hasOwn(updates, 'reports_to')
      ? updates.reports_to
      : undefined;
  if (
    Object.hasOwn(updates, 'reportsTo') ||
    Object.hasOwn(updates, 'reports_to')
  ) {
    const reportsTo = normalizeOptionalStringField('reportsTo', reportsToValue);
    if (reportsTo) next.reportsTo = reportsTo;
    else delete next.reportsTo;
  }
  const delegatesToValue = Object.hasOwn(updates, 'delegatesTo')
    ? updates.delegatesTo
    : Object.hasOwn(updates, 'delegates_to')
      ? updates.delegates_to
      : undefined;
  if (
    Object.hasOwn(updates, 'delegatesTo') ||
    Object.hasOwn(updates, 'delegates_to')
  ) {
    const delegatesTo = normalizeOptionalStringArrayField(
      'delegatesTo',
      delegatesToValue,
    );
    if (delegatesTo !== undefined) next.delegatesTo = delegatesTo;
    else delete next.delegatesTo;
  }
  if (Object.hasOwn(updates, 'peers')) {
    const peers = normalizeOptionalStringArrayField('peers', updates.peers);
    if (peers !== undefined) next.peers = peers;
    else delete next.peers;
  }
  if (Object.hasOwn(updates, 'cv')) {
    if (updates.cv === null) {
      delete next.cv;
    } else {
      const cv = normalizeAgentCv(updates.cv);
      if (!cv) {
        throw new Error(
          '`cv` must include at least one populated summary, background, capabilities, or asset field, or null.',
        );
      }
      next.cv = cv;
    }
  }
  if (Object.hasOwn(updates, 'escalationTarget')) {
    if (updates.escalationTarget === null) {
      delete next.escalationTarget;
    } else {
      const escalationTarget = normalizeAgentEscalationTarget(
        updates.escalationTarget,
      );
      if (!escalationTarget) {
        throw new Error(
          '`escalationTarget` must include non-empty string `channel` and `recipient` fields, or null.',
        );
      }
      next.escalationTarget = escalationTarget;
    }
  }
  return next;
}

function resolveMarkdownInput(
  payload: AgentConfigJsonPayload,
): Record<string, string> {
  if (payload.markdown !== undefined && payload.files !== undefined) {
    throw new Error('Provide either `markdown` or `files`, not both.');
  }
  const markdown = payload.markdown ?? payload.files;
  if (markdown === undefined) return {};
  if (!isRecord(markdown)) {
    throw new Error(
      '`markdown`/`files` must be an object of filename to text.',
    );
  }
  const result: Record<string, string> = {};
  for (const [fileName, content] of Object.entries(markdown)) {
    if (typeof content !== 'string') {
      throw new Error(`Markdown file "${fileName}" must have string content.`);
    }
    result[fileName] = content;
  }
  return result;
}

function normalizeTopLevelMarkdownFileName(fileName: string): string {
  const normalized = fileName.trim();
  if (!TOP_LEVEL_MARKDOWN_FILE_RE.test(normalized)) {
    throw new Error(
      `Unsupported markdown file "${fileName}". Use a top-level .md filename such as IDENTITY.md.`,
    );
  }
  return normalized;
}

function parseImageAssetUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function normalizeImageExtension(value: string): string {
  const ext = path.extname(value).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : '';
}

function safeImageAssetFileName(
  sourceName: string,
  fallbackExt: string,
): string {
  const ext = normalizeImageExtension(sourceName) || fallbackExt;
  if (!ext) {
    throw new Error(
      '`imageAsset` must reference a supported image file: .gif, .jpg, .jpeg, .png, .svg, or .webp.',
    );
  }
  const rawBase = path.basename(sourceName, path.extname(sourceName));
  const safeBase = rawBase
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return `${safeBase || 'agent-avatar'}${ext}`;
}

function writeImportedImageAsset(params: {
  workspacePath: string;
  fileName: string;
  content: Buffer;
}): string {
  if (params.content.byteLength > IMAGE_ASSET_MAX_BYTES) {
    throw new Error(
      `Image asset "${params.fileName}" exceeds the ${IMAGE_ASSET_MAX_BYTES}-byte limit.`,
    );
  }
  const relativePath = `${IMAGE_ASSET_DIR}/${params.fileName}`;
  const targetPath = path.join(params.workspacePath, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tempPath, params.content);
  fs.renameSync(tempPath, targetPath);
  return relativePath;
}

async function downloadImageAsset(
  workspacePath: string,
  url: URL,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download imageAsset from ${url.toString()}: ${response.status} ${response.statusText}`,
    );
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > IMAGE_ASSET_MAX_BYTES) {
    throw new Error(
      `Image asset "${url.toString()}" exceeds the ${IMAGE_ASSET_MAX_BYTES}-byte limit.`,
    );
  }
  const contentType =
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ||
    '';
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error('`imageAsset` URL must return an image content type.');
  }
  const fallbackExt = IMAGE_EXTENSION_BY_MIME_TYPE[contentType] || '';
  const sourceName = decodeURIComponent(path.basename(url.pathname) || '');
  const fileName = safeImageAssetFileName(sourceName, fallbackExt);
  const content = Buffer.from(await response.arrayBuffer());
  return writeImportedImageAsset({ workspacePath, fileName, content });
}

function resolveLocalImageAssetPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return fileURLToPath(url);
    return null;
  } catch {
    // Not a URL; continue with local path checks.
  }
  if (
    path.isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../')
  ) {
    return path.resolve(value);
  }
  const cwdRelativePath = path.resolve(value);
  if (fs.existsSync(cwdRelativePath)) return cwdRelativePath;
  return null;
}

function copyLocalImageAsset(
  workspacePath: string,
  sourcePath: string,
): string {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(sourcePath);
  } catch {
    throw new Error(`Image asset file not found: ${sourcePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Image asset is not a file: ${sourcePath}`);
  }
  if (stats.size > IMAGE_ASSET_MAX_BYTES) {
    throw new Error(
      `Image asset "${sourcePath}" exceeds the ${IMAGE_ASSET_MAX_BYTES}-byte limit.`,
    );
  }
  const workspaceRelative = path.relative(workspacePath, sourcePath);
  if (
    workspaceRelative &&
    !workspaceRelative.startsWith('..') &&
    !path.isAbsolute(workspaceRelative)
  ) {
    return workspaceRelative.split(path.sep).join('/');
  }
  const fileName = safeImageAssetFileName(path.basename(sourcePath), '');
  return writeImportedImageAsset({
    workspacePath,
    fileName,
    content: fs.readFileSync(sourcePath),
  });
}

async function importImageAssetIfNeeded(
  workspacePath: string,
  imageAsset: string,
): Promise<string> {
  const url = parseImageAssetUrl(imageAsset);
  if (url) return downloadImageAsset(workspacePath, url);
  const localPath = resolveLocalImageAssetPath(imageAsset);
  if (localPath) return copyLocalImageAsset(workspacePath, localPath);
  return imageAsset;
}

function writeWorkspaceMarkdownFile(
  workspacePath: string,
  fileName: string,
  content: string,
): void {
  const filePath = path.join(workspacePath, fileName);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

function normalizeMarkdownEntries(
  markdown: Record<string, string>,
): Array<{ fileName: string; content: string }> {
  return Object.entries(markdown).map(([fileName, content]) => {
    const normalizedFileName = normalizeTopLevelMarkdownFileName(fileName);
    const sizeBytes = Buffer.byteLength(content, 'utf-8');
    if (sizeBytes > MARKDOWN_MAX_BYTES) {
      throw new Error(
        `Markdown file "${normalizedFileName}" exceeds the ${MARKDOWN_MAX_BYTES}-byte limit.`,
      );
    }
    return {
      fileName: normalizedFileName,
      content,
    };
  });
}

export async function applyAgentConfigJson(
  rawJson: string,
  options: ApplyAgentConfigJsonOptions = {},
): Promise<ApplyAgentConfigJsonResult> {
  const payload = parseAgentConfigJson(rawJson);
  const configInput = resolveAgentConfigInput(payload);
  const id = normalizeOptionalString(configInput.id);
  if (!id) {
    throw new Error('Agent config JSON requires a non-empty `id`.');
  }
  const markdownEntries = normalizeMarkdownEntries(
    resolveMarkdownInput(payload),
  );

  const existing = getStoredAgentConfig(id) ?? getAgentById(id) ?? { id };
  const nextAgent = applyAgentConfigFieldUpdates(existing, configInput);
  ensureBootstrapFiles(nextAgent.id);
  const workspacePath = path.resolve(agentWorkspaceDir(nextAgent.id));
  fs.mkdirSync(workspacePath, { recursive: true });
  if (
    Object.hasOwn(configInput, 'imageAsset') &&
    typeof nextAgent.imageAsset === 'string'
  ) {
    nextAgent.imageAsset = await importImageAssetIfNeeded(
      workspacePath,
      nextAgent.imageAsset,
    );
  }
  const saved = upsertRegisteredAgent(nextAgent);
  const markdownFiles: string[] = [];
  for (const entry of markdownEntries) {
    writeWorkspaceMarkdownFile(workspacePath, entry.fileName, entry.content);
    markdownFiles.push(entry.fileName);
  }
  const runtimeConfigChanged = options.activate
    ? activateAgentInRuntimeConfig(saved)
    : false;

  return {
    agent: saved,
    workspacePath,
    markdownFiles,
    runtimeConfigChanged,
  };
}
