import fs from 'node:fs';
import path from 'node:path';

import { agentWorkspaceDir } from '../infra/ipc.js';
import { normalizeOptionalTrimmedUniqueStringArray } from '../utils/normalized-strings.js';
import { ensureBootstrapFiles } from '../workspace.js';
import {
  getAgentById,
  getStoredAgentConfig,
  upsertRegisteredAgent,
} from './agent-registry.js';
import { activateAgentInRuntimeConfig } from './agent-runtime-config.js';
import type { AgentConfig, AgentModelConfig } from './agent-types.js';

const MARKDOWN_MAX_BYTES = 200_000;
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

export function applyAgentConfigJson(
  rawJson: string,
  options: ApplyAgentConfigJsonOptions = {},
): ApplyAgentConfigJsonResult {
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
  const saved = upsertRegisteredAgent(
    applyAgentConfigFieldUpdates(existing, configInput),
  );
  ensureBootstrapFiles(saved.id);
  const workspacePath = path.resolve(agentWorkspaceDir(saved.id));
  fs.mkdirSync(workspacePath, { recursive: true });
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
