import fs from 'node:fs';
import path from 'node:path';

import { updateRuntimeConfig } from '../config/runtime-config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { normalizeOptionalTrimmedUniqueStringArray } from '../utils/normalized-strings.js';
import { ensureBootstrapFiles } from '../workspace.js';
import {
  getAgentById,
  getStoredAgentConfig,
  upsertRegisteredAgent,
} from './agent-registry.js';
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
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
  const id = normalizeOptionalString(updates.id) || base.id;
  if (!id) {
    throw new Error('Agent config JSON requires a non-empty `id`.');
  }

  const next: AgentConfig = { ...base, id };
  if (hasOwn(updates, 'name')) {
    const name = normalizeOptionalString(updates.name);
    if (name) next.name = name;
    else delete next.name;
  }
  if (hasOwn(updates, 'displayName')) {
    const displayName = normalizeOptionalString(updates.displayName);
    if (displayName) next.displayName = displayName;
    else delete next.displayName;
  }
  if (hasOwn(updates, 'imageAsset')) {
    const imageAsset = normalizeOptionalString(updates.imageAsset);
    if (imageAsset) next.imageAsset = imageAsset;
    else delete next.imageAsset;
  }
  if (hasOwn(updates, 'model')) {
    const model = normalizeModelConfig(updates.model);
    if (model) next.model = model;
    else delete next.model;
  }
  if (hasOwn(updates, 'skills')) {
    const skills = normalizeOptionalTrimmedUniqueStringArray(updates.skills);
    if (skills !== undefined) next.skills = skills;
    else delete next.skills;
  }
  if (hasOwn(updates, 'workspace')) {
    const workspace = normalizeOptionalString(updates.workspace);
    if (workspace) next.workspace = workspace;
    else delete next.workspace;
  }
  if (hasOwn(updates, 'chatbotId')) {
    const chatbotId = normalizeOptionalString(updates.chatbotId);
    if (chatbotId) next.chatbotId = chatbotId;
    else delete next.chatbotId;
  }
  if (hasOwn(updates, 'enableRag')) {
    if (typeof updates.enableRag === 'boolean') {
      next.enableRag = updates.enableRag;
    } else {
      delete next.enableRag;
    }
  }
  return next;
}

function resolveMarkdownInput(
  payload: AgentConfigJsonPayload,
): Record<string, string> {
  const markdownMaps = [payload.markdown, payload.files].filter(
    (entry) => entry !== undefined,
  );
  if (markdownMaps.length === 0) return {};
  if (markdownMaps.length > 1) {
    throw new Error('Provide either `markdown` or `files`, not both.');
  }
  const markdown = markdownMaps[0];
  if (!isRecord(markdown)) {
    throw new Error('`markdown`/`files` must be an object of filename to text.');
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

function writeWorkspaceMarkdownFile(params: {
  workspacePath: string;
  fileName: string;
  content: string;
}): void {
  const sizeBytes = Buffer.byteLength(params.content, 'utf-8');
  if (sizeBytes > MARKDOWN_MAX_BYTES) {
    throw new Error(
      `Markdown file "${params.fileName}" exceeds the ${MARKDOWN_MAX_BYTES}-byte limit.`,
    );
  }

  const filePath = path.join(params.workspacePath, params.fileName);
  fs.mkdirSync(params.workspacePath, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tempPath, params.content, 'utf-8');
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

function activateAgent(agent: AgentConfig): void {
  updateRuntimeConfig((draft) => {
    draft.agents ??= {};
    const nextAgents = Array.isArray(draft.agents.list)
      ? [...draft.agents.list]
      : [];
    const existingIndex = nextAgents.findIndex(
      (entry) => entry?.id?.trim() === agent.id,
    );
    if (existingIndex >= 0) {
      nextAgents[existingIndex] = agent;
    } else {
      nextAgents.push(agent);
    }
    draft.agents.list = nextAgents;
    draft.agents.defaultAgentId = agent.id;
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
  const markdownEntries = normalizeMarkdownEntries(resolveMarkdownInput(payload));

  const existing = getStoredAgentConfig(id) ?? getAgentById(id) ?? { id };
  const saved = upsertRegisteredAgent(
    applyAgentConfigFieldUpdates(existing, configInput),
  );
  ensureBootstrapFiles(saved.id);
  const workspacePath = path.resolve(agentWorkspaceDir(saved.id));
  const markdownFiles: string[] = [];
  for (const entry of markdownEntries) {
    writeWorkspaceMarkdownFile({
      workspacePath,
      fileName: entry.fileName,
      content: entry.content,
    });
    markdownFiles.push(entry.fileName);
  }
  if (options.activate) {
    activateAgent(saved);
  }

  return {
    agent: saved,
    workspacePath,
    markdownFiles,
    runtimeConfigChanged: Boolean(options.activate),
  };
}
