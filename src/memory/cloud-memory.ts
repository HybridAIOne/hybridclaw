import { randomBytes } from 'node:crypto';
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
}

interface CloudMemorySyncResponse {
  enabled?: boolean;
  files?: CloudMemoryFilePayload[];
}

interface CloudMemoryCache {
  files: CloudMemoryContextFile[];
}

const CLOUD_MEMORY_CACHE_NAME = 'cloud-memory.json';
const CLOUD_MEMORY_MAX_FILE_CHARS = 20_000;
const CLOUD_MEMORY_PROMPT_FILE_CHARS = 12_000;
const CLOUD_MEMORY_MAX_DAILY_FILES = 14;
const CLOUD_MEMORY_SYNC_MIN_INTERVAL_MS = 60_000;
const CLOUD_MEMORY_PERIODIC_SYNC_INTERVAL_MS = 5 * 60_000;
const CLOUD_MEMORY_FETCH_TIMEOUT_MS = 30_000;
const CLOUD_MEMORY_SOURCE_FILES = new Set(['MEMORY.md', 'USER.md']);
const DAILY_MEMORY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

const inFlightSyncs = new Map<string, Promise<void>>();
const lastSyncStartedAt = new Map<string, number>();
let periodicSyncTimer: ReturnType<typeof setInterval> | null = null;

function getCloudMemoryConfig(): {
  apiKey: string;
  baseUrl: string;
  chatbotId: string;
} {
  return {
    apiKey: readRuntimeConfigString(() => runtimeConfig.HYBRIDAI_API_KEY),
    baseUrl: readRuntimeConfigString(() => runtimeConfig.HYBRIDAI_BASE_URL),
    chatbotId: readRuntimeConfigString(() => runtimeConfig.HYBRIDAI_CHATBOT_ID),
  };
}

function readRuntimeConfigString(read: () => unknown): string {
  try {
    const value = read();
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized.startsWith('https://')) {
    throw new Error('HYBRIDAI_BASE_URL must use HTTPS for cloud memory sync');
  }
  return normalized;
}

function isCloudMemoryConfigured(): boolean {
  const config = getCloudMemoryConfig();
  return Boolean(
    config.apiKey.trim() && config.baseUrl.trim() && config.chatbotId.trim(),
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

function normalizeCloudPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeCloudFile(
  file: CloudMemoryFilePayload,
): CloudMemoryContextFile | null {
  if (file.scope !== 'installation' && file.scope !== 'company') return null;
  const name = normalizeCloudPath(file.path);
  if (!name) return null;
  const content = file.content.trim();
  if (!content) return null;
  return {
    scope: file.scope,
    name,
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
    files,
  };
  const tempPath = `${cachePath}.tmp-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, 'utf-8');
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
    if (!Array.isArray(parsed.files)) return null;
    return {
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
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return;
  const config = getCloudMemoryConfig();
  const apiKey = config.apiKey.trim();
  const baseUrl = config.baseUrl.trim();
  const chatbotId = config.chatbotId.trim();
  if (!apiKey || !baseUrl || !chatbotId) return;
  const localFiles = collectLocalAgentMemoryFiles(normalizedAgentId);
  const url = `${normalizeBaseUrl(baseUrl)}/api/hybridclaw/memory/sync`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CLOUD_MEMORY_FETCH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatbot_id: chatbotId,
        agent_id: normalizedAgentId,
        files: localFiles,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    clearCloudMemoryCache(normalizedAgentId);
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
    normalizedAgentId,
    cloudFiles
      .map(normalizeCloudFile)
      .filter((file): file is CloudMemoryContextFile => file !== null),
  );
}

export function scheduleCloudMemorySync(agentId: string): void {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return;
  if (!isCloudMemoryConfigured()) return;
  if (inFlightSyncs.has(normalizedAgentId)) return;

  const now = Date.now();
  const lastStarted = lastSyncStartedAt.get(normalizedAgentId) || 0;
  if (now - lastStarted < CLOUD_MEMORY_SYNC_MIN_INTERVAL_MS) return;
  lastSyncStartedAt.set(normalizedAgentId, now);

  const promise = syncCloudMemoryNow(normalizedAgentId)
    .catch((err) => {
      logger.warn(
        { agentId: normalizedAgentId, err },
        'Cloud memory sync failed',
      );
    })
    .finally(() => {
      inFlightSyncs.delete(normalizedAgentId);
    });
  inFlightSyncs.set(normalizedAgentId, promise);
}

function syncAgentIds(agentIds: string[]): void {
  const uniqueAgentIds = Array.from(
    new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean)),
  );
  for (const agentId of uniqueAgentIds) {
    scheduleCloudMemorySync(agentId);
  }
}

export function startPeriodicCloudMemorySync(options?: {
  intervalMs?: number;
  resolveAgentIds?: () => string[];
  syncImmediately?: boolean;
}): void {
  stopPeriodicCloudMemorySync();
  if (!isCloudMemoryConfigured()) return;

  const intervalMs = Math.max(
    CLOUD_MEMORY_SYNC_MIN_INTERVAL_MS,
    options?.intervalMs ?? CLOUD_MEMORY_PERIODIC_SYNC_INTERVAL_MS,
  );
  const resolveAgentIds = options?.resolveAgentIds ?? (() => ['main']);
  const runSync = () => {
    try {
      syncAgentIds(resolveAgentIds());
    } catch (err) {
      logger.warn({ err }, 'Cloud memory periodic sync failed to list agents');
    }
  };

  if (options?.syncImmediately !== false) {
    runSync();
  }
  periodicSyncTimer = setInterval(runSync, intervalMs);
}

export function stopPeriodicCloudMemorySync(): void {
  if (!periodicSyncTimer) return;
  clearInterval(periodicSyncTimer);
  periodicSyncTimer = null;
}
