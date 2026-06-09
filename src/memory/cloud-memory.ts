import fs from 'node:fs';
import path from 'node:path';

import {
  currentDateStampInTimezone,
  extractUserTimezone,
} from '../../container/shared/workspace-time.js';
import * as runtimeConfig from '../config/config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { truncateHeadTailText } from '../session/token-efficiency.js';

export type CloudMemoryScope = 'installation' | 'company';

export interface CloudMemoryContextFile {
  scope: CloudMemoryScope;
  name: string;
  content: string;
}

interface CloudMemoryFilePayload {
  scope: 'agent' | CloudMemoryScope;
  path: string;
  content: string;
  updated_at?: string | null;
}

interface CloudMemorySyncResponse {
  enabled?: boolean;
  files?: CloudMemoryFilePayload[];
}

interface CloudMemoryCache {
  version: 1;
  updatedAt: string;
  files: CloudMemoryContextFile[];
}

const CLOUD_MEMORY_CACHE_VERSION = 1;
const CLOUD_MEMORY_CACHE_NAME = 'cloud-memory.json';
const CLOUD_MEMORY_MAX_FILE_CHARS = 20_000;
const CLOUD_MEMORY_PROMPT_FILE_CHARS = 12_000;
const CLOUD_MEMORY_MAX_DAILY_FILES = 14;
const CLOUD_MEMORY_SYNC_MIN_INTERVAL_MS = 60_000;
const CLOUD_MEMORY_SOURCE_FILES = new Set(['MEMORY.md', 'USER.md']);
const DAILY_MEMORY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

const inFlightSyncs = new Map<string, Promise<void>>();
const lastSyncStartedAt = new Map<string, number>();

type CloudMemoryConfigKey =
  | 'HYBRIDAI_API_KEY'
  | 'HYBRIDAI_BASE_URL'
  | 'HYBRIDAI_CHATBOT_ID';

function getCloudMemoryConfigValue(key: CloudMemoryConfigKey): string {
  let value: unknown;
  try {
    switch (key) {
      case 'HYBRIDAI_API_KEY':
        value = runtimeConfig.HYBRIDAI_API_KEY;
        break;
      case 'HYBRIDAI_BASE_URL':
        value = runtimeConfig.HYBRIDAI_BASE_URL;
        break;
      case 'HYBRIDAI_CHATBOT_ID':
        value = runtimeConfig.HYBRIDAI_CHATBOT_ID;
        break;
    }
  } catch {
    return '';
  }
  return typeof value === 'string' ? value : '';
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function isCloudMemoryConfigured(): boolean {
  return Boolean(
    getCloudMemoryConfigValue('HYBRIDAI_API_KEY').trim() &&
      getCloudMemoryConfigValue('HYBRIDAI_BASE_URL').trim() &&
      getCloudMemoryConfigValue('HYBRIDAI_CHATBOT_ID').trim(),
  );
}

function cloudMemoryCachePath(agentId: string): string {
  return path.join(
    agentWorkspaceDir(agentId),
    '.hybridclaw',
    CLOUD_MEMORY_CACHE_NAME,
  );
}

function readBoundedTextFile(
  filePath: string,
  maxChars: number,
): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= 0) return '';
    if (stats.size <= maxChars) {
      return fs.readFileSync(filePath, 'utf-8');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxChars);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return `${buffer.toString('utf8', 0, bytesRead)}\n...[truncated]`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function resolveTodayMemoryName(workspaceDir: string): string {
  const userPath = path.join(workspaceDir, 'USER.md');
  const userContent = readBoundedTextFile(
    userPath,
    CLOUD_MEMORY_MAX_FILE_CHARS,
  );
  const timezone = extractUserTimezone(userContent || undefined);
  return `${currentDateStampInTimezone(timezone)}.md`;
}

function selectDailyMemoryFilenames(
  filenames: string[],
  todayName: string,
): string[] {
  if (filenames.length <= CLOUD_MEMORY_MAX_DAILY_FILES) return filenames;

  const hasToday = filenames.includes(todayName);
  if (!hasToday) {
    return filenames.slice(-CLOUD_MEMORY_MAX_DAILY_FILES);
  }

  const recentWithoutToday = filenames
    .filter((filename) => filename !== todayName)
    .slice(-(CLOUD_MEMORY_MAX_DAILY_FILES - 1));
  return [...recentWithoutToday, todayName].sort();
}

function collectLocalAgentMemoryFiles(
  agentId: string,
): CloudMemoryFilePayload[] {
  const workspaceDir = agentWorkspaceDir(agentId);
  const files: CloudMemoryFilePayload[] = [];

  for (const filename of CLOUD_MEMORY_SOURCE_FILES) {
    const filePath = path.join(workspaceDir, filename);
    const content = readBoundedTextFile(filePath, CLOUD_MEMORY_MAX_FILE_CHARS);
    if (content == null || !content.trim()) continue;
    files.push({ scope: 'agent', path: `/${filename}`, content });
  }

  const memoryDir = path.join(workspaceDir, 'memory');
  const todayName = resolveTodayMemoryName(workspaceDir);
  try {
    const entries = fs
      .readdirSync(memoryDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && DAILY_MEMORY_FILE_RE.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    for (const filename of selectDailyMemoryFilenames(entries, todayName)) {
      const content = readBoundedTextFile(
        path.join(memoryDir, filename),
        filename === todayName
          ? CLOUD_MEMORY_MAX_FILE_CHARS
          : Math.floor(CLOUD_MEMORY_MAX_FILE_CHARS / 2),
      );
      if (content == null || !content.trim()) continue;
      files.push({ scope: 'agent', path: `/memory/${filename}`, content });
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.warn({ agentId, err }, 'Failed to enumerate local memory files');
    }
  }

  return files;
}

function normalizeCloudPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '/MEMORY.md';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeCloudFile(
  file: CloudMemoryFilePayload,
): CloudMemoryContextFile | null {
  if (file.scope !== 'installation' && file.scope !== 'company') return null;
  const content = file.content.trim();
  if (!content) return null;
  return {
    scope: file.scope,
    name: normalizeCloudPath(file.path),
    content: truncateHeadTailText(content, CLOUD_MEMORY_PROMPT_FILE_CHARS),
  };
}

function writeCloudMemoryCache(
  agentId: string,
  files: CloudMemoryContextFile[],
): void {
  const cachePath = cloudMemoryCachePath(agentId);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const payload: CloudMemoryCache = {
    version: CLOUD_MEMORY_CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    files,
  };
  const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  fs.renameSync(tempPath, cachePath);
}

function clearCloudMemoryCache(agentId: string): void {
  try {
    fs.unlinkSync(cloudMemoryCachePath(agentId));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.warn({ agentId, err }, 'Failed to clear cloud memory cache');
    }
  }
}

function readCloudMemoryCache(agentId: string): CloudMemoryCache | null {
  try {
    const raw = fs.readFileSync(cloudMemoryCachePath(agentId), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CloudMemoryCache>;
    if (parsed.version !== CLOUD_MEMORY_CACHE_VERSION) return null;
    if (!Array.isArray(parsed.files)) return null;
    return {
      version: CLOUD_MEMORY_CACHE_VERSION,
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date(0).toISOString(),
      files: parsed.files.filter(
        (file): file is CloudMemoryContextFile =>
          (file?.scope === 'installation' || file?.scope === 'company') &&
          typeof file.name === 'string' &&
          typeof file.content === 'string',
      ),
    };
  } catch {
    return null;
  }
}

export function loadCloudMemoryContextFiles(
  agentId: string,
): CloudMemoryContextFile[] {
  const cache = readCloudMemoryCache(agentId);
  return cache?.files || [];
}

export async function syncCloudMemoryNow(agentId: string): Promise<void> {
  if (!isCloudMemoryConfigured()) return;
  const apiKey = getCloudMemoryConfigValue('HYBRIDAI_API_KEY').trim();
  const baseUrl = getCloudMemoryConfigValue('HYBRIDAI_BASE_URL').trim();
  const chatbotId = getCloudMemoryConfigValue('HYBRIDAI_CHATBOT_ID').trim();
  const localFiles = collectLocalAgentMemoryFiles(agentId);
  const url = `${normalizeBaseUrl(baseUrl)}/api/hybridclaw/memory/sync`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chatbot_id: chatbotId,
      agent_id: agentId,
      files: localFiles,
    }),
  });

  if (response.status === 404) {
    clearCloudMemoryCache(agentId);
    return;
  }
  if (!response.ok) {
    throw new Error(`HybridAI memory sync failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as CloudMemorySyncResponse;
  if (!body.enabled) {
    clearCloudMemoryCache(agentId);
    return;
  }

  const cloudFiles = Array.isArray(body.files) ? body.files : [];
  writeCloudMemoryCache(
    agentId,
    cloudFiles
      .map(normalizeCloudFile)
      .filter((file): file is CloudMemoryContextFile => file !== null),
  );
}

export function scheduleCloudMemorySync(agentId: string): void {
  if (!isCloudMemoryConfigured()) return;
  if (inFlightSyncs.has(agentId)) return;

  const now = Date.now();
  const lastStarted = lastSyncStartedAt.get(agentId) || 0;
  if (now - lastStarted < CLOUD_MEMORY_SYNC_MIN_INTERVAL_MS) return;
  lastSyncStartedAt.set(agentId, now);

  const promise = syncCloudMemoryNow(agentId)
    .catch((err) => {
      logger.warn({ agentId, err }, 'Cloud memory sync failed');
    })
    .finally(() => {
      inFlightSyncs.delete(agentId);
    });
  inFlightSyncs.set(agentId, promise);
}
