import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  listAgents,
  resolveAgentForRequest,
  resolveAgentWorkspaceId,
} from '../../agents/agent-registry.js';
import {
  DATA_DIR,
  DB_PATH,
  SESSION_COMPACTION_ENABLED,
  SESSION_COMPACTION_THRESHOLD,
} from '../../config/config.js';
import { maybeCompactSession } from '../../session/session-maintenance.js';
import type { DiagFix, DiagResult, DoctorCheck } from '../types.js';
import {
  formatBytes,
  formatDuration,
  makeResult,
  readDirSize,
  readDiskFreeBytes,
  shortenHomePath,
  toErrorMessage,
} from '../utils.js';

const AGENTS_DIR_NAME = 'agents';
const EVALS_DIR_NAME = 'evals';
const SESSION_EXPORTS_DIR_NAME = '.session-exports';
const TRACE_EXPORTS_DIR_NAME = '.trace-exports';
const WORKSPACE_DIR_NAME = 'workspace';
const PROMPT_DUMP_FILE_NAME = 'last_prompt.jsonl';
const CRITICAL_FREE_SPACE_BYTES = 100 * 1024 * 1024;
const STALE_WORKSPACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TEMP_MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RUN_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ORPHANED_EXPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROMPT_DUMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_COMPACTION_IDLE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MANAGED_TEMP_MEDIA_DIR_PREFIXES = ['hybridclaw-wa-', 'hybridclaw-slack-'];

interface CleanupCandidate {
  path: string;
  displayPath: string;
  sizeBytes: number;
  ageMs: number;
}

interface WorkspaceCandidate extends CleanupCandidate {
  workspaceId: string;
  gitBacked: boolean;
}

interface SessionSnapshot {
  id: string;
  agentId: string;
  channelId: string;
  chatbotId: string | null;
  model: string | null;
  enableRag: boolean;
  messageCount: number;
  lastActive: string;
  lastActiveMs: number | null;
}

interface SessionDatabaseSnapshot {
  currentSessions: SessionSnapshot[];
  allSessionKeys: Set<string>;
}

function safeFilePart(raw: string): string {
  const normalized = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'session';
}

function formatAge(ageMs: number): string {
  return formatDuration(ageMs / 1000);
}

function sumCandidateBytes(candidates: CleanupCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
}

function maxCandidateAgeMs(candidates: CleanupCandidate[]): number {
  return candidates.reduce(
    (max, candidate) => Math.max(max, candidate.ageMs),
    0,
  );
}

function removeCleanupPath(targetPath: string): void {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(targetPath);
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function buildCleanupFix(params: {
  summary: string;
  candidates: CleanupCandidate[];
  requiresApproval?: boolean;
}): DiagFix {
  return {
    summary: params.summary,
    requiresApproval: params.requiresApproval === true,
    apply: async () => {
      for (const candidate of params.candidates) {
        if (!fs.existsSync(candidate.path)) continue;
        removeCleanupPath(candidate.path);
      }
    },
  };
}

function readCriticalDiskState(): {
  freeBytes: number | null;
  critical: boolean;
} {
  const freeBytes = readDiskFreeBytes(DATA_DIR);
  return {
    freeBytes,
    critical: freeBytes != null && freeBytes < CRITICAL_FREE_SPACE_BYTES,
  };
}

function openReadonlyDatabase(): Database.Database {
  return new Database(DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
}

function databaseHasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

function loadSessionSnapshotFromDatabase(): SessionDatabaseSnapshot {
  const db = openReadonlyDatabase();
  try {
    const currentSessionSql = databaseHasColumn(db, 'sessions', 'is_current')
      ? `SELECT id, agent_id, channel_id, chatbot_id, model, enable_rag, message_count, last_active
           FROM sessions
          WHERE is_current = 1`
      : `SELECT id, agent_id, channel_id, chatbot_id, model, enable_rag, message_count, last_active
           FROM sessions`;
    const currentSessionRows = db.prepare(currentSessionSql).all() as Array<{
      id: string;
      agent_id: string;
      channel_id: string;
      chatbot_id: string | null;
      model: string | null;
      enable_rag: number;
      message_count: number;
      last_active: string;
    }>;
    const allSessionRows = db
      .prepare('SELECT id FROM sessions')
      .all() as Array<{ id: string }>;

    return {
      currentSessions: currentSessionRows.map((row) => {
        const lastActiveMs = Date.parse(row.last_active);
        return {
          id: row.id,
          agentId: row.agent_id,
          channelId: row.channel_id,
          chatbotId: row.chatbot_id,
          model: row.model,
          enableRag: Number(row.enable_rag || 0) > 0,
          messageCount: Math.max(0, Math.floor(row.message_count || 0)),
          lastActive: row.last_active,
          lastActiveMs: Number.isFinite(lastActiveMs) ? lastActiveMs : null,
        };
      }),
      allSessionKeys: new Set(
        allSessionRows.map((row) => safeFilePart(String(row.id || ''))),
      ),
    };
  } finally {
    db.close();
  }
}

function readDirEntries(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listManagedTempMediaCandidates(
  nowMs = Date.now(),
): CleanupCandidate[] {
  const rootDir = os.tmpdir();
  const candidates: CleanupCandidate[] = [];

  for (const entry of readDirEntries(rootDir)) {
    if (
      !MANAGED_TEMP_MEDIA_DIR_PREFIXES.some((prefix) =>
        entry.name.startsWith(prefix),
      )
    ) {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch {
      continue;
    }

    const ageMs = Math.max(0, nowMs - stat.mtimeMs);
    if (ageMs < TEMP_MEDIA_MAX_AGE_MS) continue;
    const sizeBytes = stat.isDirectory() ? readDirSize(entryPath) : stat.size;
    candidates.push({
      path: entryPath,
      displayPath: shortenHomePath(entryPath),
      sizeBytes,
      ageMs,
    });
  }

  return candidates;
}

function listFinishedEvalRunCandidates(nowMs = Date.now()): CleanupCandidate[] {
  const baseDir = path.join(DATA_DIR, EVALS_DIR_NAME);
  const candidates: CleanupCandidate[] = [];

  for (const entry of readDirEntries(baseDir)) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(baseDir, entry.name);
    const metaPath = path.join(runDir, 'run.json');
    if (!fs.existsSync(metaPath)) continue;

    let finishedAtMs: number | null = null;
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed = JSON.parse(raw) as { finishedAt?: string | null };
      const finishedAt = String(parsed.finishedAt || '').trim();
      if (finishedAt) {
        const parsedMs = Date.parse(finishedAt);
        finishedAtMs = Number.isFinite(parsedMs) ? parsedMs : null;
      }
    } catch {
      continue;
    }
    if (finishedAtMs == null) continue;

    const ageMs = Math.max(0, nowMs - finishedAtMs);
    if (ageMs < RUN_LOG_MAX_AGE_MS) continue;
    candidates.push({
      path: runDir,
      displayPath: shortenHomePath(runDir),
      sizeBytes: readDirSize(runDir),
      ageMs,
    });
  }

  return candidates;
}

function listPotentialStaleWorkspaceCandidates(
  configuredWorkspaceIds: Set<string>,
  nowMs = Date.now(),
): WorkspaceCandidate[] {
  const agentsRoot = path.join(DATA_DIR, AGENTS_DIR_NAME);
  const candidates: WorkspaceCandidate[] = [];

  for (const entry of readDirEntries(agentsRoot)) {
    if (!entry.isDirectory()) continue;
    if (configuredWorkspaceIds.has(entry.name)) continue;

    const rootPath = path.join(agentsRoot, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch {
      continue;
    }
    const ageMs = Math.max(0, nowMs - stat.mtimeMs);
    if (ageMs < STALE_WORKSPACE_MAX_AGE_MS) continue;

    const workspacePath = path.join(rootPath, WORKSPACE_DIR_NAME);
    candidates.push({
      path: rootPath,
      displayPath: shortenHomePath(rootPath),
      sizeBytes: readDirSize(rootPath),
      ageMs,
      workspaceId: entry.name,
      gitBacked: fs.existsSync(path.join(workspacePath, '.git')),
    });
  }

  return candidates;
}

function listPotentialOrphanedExportCandidates(
  nowMs = Date.now(),
): CleanupCandidate[] {
  const agentsRoot = path.join(DATA_DIR, AGENTS_DIR_NAME);
  const candidates: CleanupCandidate[] = [];

  for (const entry of readDirEntries(agentsRoot)) {
    if (!entry.isDirectory()) continue;
    const workspacePath = path.join(agentsRoot, entry.name, WORKSPACE_DIR_NAME);
    for (const exportDirName of [
      SESSION_EXPORTS_DIR_NAME,
      TRACE_EXPORTS_DIR_NAME,
    ]) {
      const exportRoot = path.join(workspacePath, exportDirName);
      for (const exportEntry of readDirEntries(exportRoot)) {
        if (!exportEntry.isDirectory()) continue;
        const exportPath = path.join(exportRoot, exportEntry.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(exportPath);
        } catch {
          continue;
        }
        const ageMs = Math.max(0, nowMs - stat.mtimeMs);
        if (ageMs < ORPHANED_EXPORT_MAX_AGE_MS) continue;
        candidates.push({
          path: exportPath,
          displayPath: shortenHomePath(exportPath),
          sizeBytes: readDirSize(exportPath),
          ageMs,
        });
      }
    }
  }

  return candidates;
}

function readPromptDumpCandidate(nowMs = Date.now()): CleanupCandidate | null {
  const promptDumpPath = path.join(DATA_DIR, PROMPT_DUMP_FILE_NAME);
  if (!fs.existsSync(promptDumpPath)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(promptDumpPath);
  } catch {
    return null;
  }

  const ageMs = Math.max(0, nowMs - stat.mtimeMs);
  if (ageMs < PROMPT_DUMP_MAX_AGE_MS) return null;
  return {
    path: promptDumpPath,
    displayPath: shortenHomePath(promptDumpPath),
    sizeBytes: stat.size,
    ageMs,
  };
}

function formatCleanupMessage(params: {
  count: number;
  totalBytes: number;
  oldestAgeMs: number;
  freeBytes?: number | null;
  note: string;
}): string {
  const parts = [
    `${params.count} item${params.count === 1 ? '' : 's'}`,
    `${formatBytes(params.totalBytes)} reclaimable`,
    `oldest ${formatAge(params.oldestAgeMs)}`,
    params.note,
  ];
  if (params.freeBytes != null) {
    parts.push(`${formatBytes(params.freeBytes)} free`);
  }
  return parts.join(', ');
}

export async function checkStaleWorkspaces(): Promise<DiagResult[]> {
  const configuredWorkspaceIds = new Set(
    listAgents().map((agent) =>
      safeFilePart(resolveAgentWorkspaceId(agent.id)),
    ),
  );
  const potentialCandidates = listPotentialStaleWorkspaceCandidates(
    configuredWorkspaceIds,
  );

  if (potentialCandidates.length === 0) {
    return [
      makeResult(
        'disk',
        'Stale workspaces',
        'ok',
        `No orphaned workspace directories older than ${formatAge(STALE_WORKSPACE_MAX_AGE_MS)}`,
      ),
    ];
  }

  let snapshot: SessionDatabaseSnapshot;
  try {
    snapshot = loadSessionSnapshotFromDatabase();
  } catch (error) {
    return [
      makeResult(
        'disk',
        'Stale workspaces',
        'error',
        `Cannot verify orphaned workspaces without ${shortenHomePath(DB_PATH)} (${toErrorMessage(error)})`,
      ),
    ];
  }

  const activeWorkspaceIds = new Set(
    snapshot.currentSessions.map((session) =>
      safeFilePart(resolveAgentWorkspaceId(session.agentId)),
    ),
  );
  const staleCandidates = potentialCandidates.filter(
    (candidate) => !activeWorkspaceIds.has(candidate.workspaceId),
  );

  if (staleCandidates.length === 0) {
    return [
      makeResult(
        'disk',
        'Stale workspaces',
        'ok',
        'No orphaned workspace directories outside configured agents and active sessions',
      ),
    ];
  }

  const { freeBytes, critical } = readCriticalDiskState();
  const safeCandidates = staleCandidates.filter(
    (candidate) => !candidate.gitBacked,
  );
  const riskyCandidates = staleCandidates.filter(
    (candidate) => candidate.gitBacked,
  );
  const results: DiagResult[] = [];

  if (safeCandidates.length > 0) {
    results.push(
      makeResult(
        'disk',
        'Stale workspaces',
        critical ? 'error' : 'warn',
        formatCleanupMessage({
          count: safeCandidates.length,
          totalBytes: sumCandidateBytes(safeCandidates),
          oldestAgeMs: maxCandidateAgeMs(safeCandidates),
          freeBytes,
          note: 'orphaned workspace directories are outside configured agents and active sessions',
        }),
        buildCleanupFix({
          summary: `Remove ${safeCandidates.length} orphaned workspace director${safeCandidates.length === 1 ? 'y' : 'ies'}`,
          candidates: safeCandidates,
          requiresApproval: critical,
        }),
      ),
    );
  }

  if (riskyCandidates.length > 0) {
    results.push(
      makeResult(
        'disk',
        'Git-backed stale workspaces',
        'error',
        formatCleanupMessage({
          count: riskyCandidates.length,
          totalBytes: sumCandidateBytes(riskyCandidates),
          oldestAgeMs: maxCandidateAgeMs(riskyCandidates),
          freeBytes,
          note: 'orphaned workspace directories contain .git and require approval',
        }),
        buildCleanupFix({
          summary: `Remove ${riskyCandidates.length} git-backed orphaned workspace director${riskyCandidates.length === 1 ? 'y' : 'ies'}`,
          candidates: riskyCandidates,
          requiresApproval: true,
        }),
      ),
    );
  }

  return results;
}

export async function checkOldTempMedia(): Promise<DiagResult[]> {
  const candidates = listManagedTempMediaCandidates();
  if (candidates.length === 0) {
    return [
      makeResult(
        'disk',
        'Old temp media',
        'ok',
        `No managed temp media older than ${formatAge(TEMP_MEDIA_MAX_AGE_MS)}`,
      ),
    ];
  }

  const { freeBytes, critical } = readCriticalDiskState();
  return [
    makeResult(
      'disk',
      'Old temp media',
      critical ? 'error' : 'warn',
      formatCleanupMessage({
        count: candidates.length,
        totalBytes: sumCandidateBytes(candidates),
        oldestAgeMs: maxCandidateAgeMs(candidates),
        freeBytes,
        note: 'managed temp media directories are safe to prune',
      }),
      buildCleanupFix({
        summary: `Delete ${candidates.length} managed temp media entr${candidates.length === 1 ? 'y' : 'ies'}`,
        candidates,
        requiresApproval: critical,
      }),
    ),
  ];
}

export async function checkOldRunLogs(): Promise<DiagResult[]> {
  const candidates = listFinishedEvalRunCandidates();
  if (candidates.length === 0) {
    return [
      makeResult(
        'disk',
        'Old run logs',
        'ok',
        `No finished run logs older than ${formatAge(RUN_LOG_MAX_AGE_MS)}`,
      ),
    ];
  }

  const { freeBytes, critical } = readCriticalDiskState();
  return [
    makeResult(
      'disk',
      'Old run logs',
      critical ? 'error' : 'warn',
      formatCleanupMessage({
        count: candidates.length,
        totalBytes: sumCandidateBytes(candidates),
        oldestAgeMs: maxCandidateAgeMs(candidates),
        freeBytes,
        note: 'finished eval run directories are safe to prune',
      }),
      buildCleanupFix({
        summary: `Prune ${candidates.length} finished run log director${candidates.length === 1 ? 'y' : 'ies'}`,
        candidates,
        requiresApproval: critical,
      }),
    ),
  ];
}

export async function checkSessionCompactionBacklog(): Promise<DiagResult[]> {
  if (!SESSION_COMPACTION_ENABLED) {
    return [
      makeResult(
        'database',
        'Session compaction backlog',
        'ok',
        'Automatic session compaction is disabled in runtime config',
      ),
    ];
  }

  let snapshot: SessionDatabaseSnapshot;
  try {
    snapshot = loadSessionSnapshotFromDatabase();
  } catch (error) {
    return [
      makeResult(
        'database',
        'Session compaction backlog',
        'error',
        `Cannot inspect session backlog without ${shortenHomePath(DB_PATH)} (${toErrorMessage(error)})`,
      ),
    ];
  }

  const nowMs = Date.now();
  const threshold = Math.max(SESSION_COMPACTION_THRESHOLD, 20);
  const backlog = snapshot.currentSessions
    .filter(
      (session) =>
        session.messageCount >= threshold &&
        session.lastActiveMs != null &&
        nowMs - session.lastActiveMs >= SESSION_COMPACTION_IDLE_MAX_AGE_MS,
    )
    .sort((left, right) => right.messageCount - left.messageCount);

  if (backlog.length === 0) {
    return [
      makeResult(
        'database',
        'Session compaction backlog',
        'ok',
        `No idle sessions exceed the ${threshold}-message compaction threshold`,
      ),
    ];
  }

  const { freeBytes, critical } = readCriticalDiskState();
  return [
    makeResult(
      'database',
      'Session compaction backlog',
      critical ? 'error' : 'warn',
      [
        `${backlog.length} idle session${backlog.length === 1 ? '' : 's'} exceed the ${threshold}-message threshold`,
        `largest ${backlog[0]?.messageCount ?? threshold} messages`,
        backlog[0]?.lastActive
          ? `oldest activity ${backlog[0].lastActive}`
          : null,
        freeBytes != null ? `${formatBytes(freeBytes)} free` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(', '),
      {
        summary: `Compact ${backlog.length} oversized idle session${backlog.length === 1 ? '' : 's'}`,
        requiresApproval: critical,
        apply: async () => {
          for (const session of backlog) {
            const resolved = resolveAgentForRequest({
              agentId: session.agentId,
              model: session.model,
              chatbotId: session.chatbotId,
            });
            await maybeCompactSession({
              sessionId: session.id,
              agentId: resolved.agentId,
              chatbotId: resolved.chatbotId,
              enableRag: session.enableRag,
              model: resolved.model,
              channelId: session.channelId || 'scheduler',
            });
          }
        },
      },
    ),
  ];
}

export async function checkOrphanedExportsAndPromptDumps(): Promise<
  DiagResult[]
> {
  const results: DiagResult[] = [];
  const exportCandidates = listPotentialOrphanedExportCandidates();
  const promptDumpCandidate = readPromptDumpCandidate();

  if (exportCandidates.length > 0) {
    let snapshot: SessionDatabaseSnapshot;
    let snapshotLoaded = true;
    try {
      snapshot = loadSessionSnapshotFromDatabase();
    } catch (error) {
      snapshotLoaded = false;
      results.push(
        makeResult(
          'disk',
          'Orphaned exports',
          'error',
          `Cannot verify export ownership without ${shortenHomePath(DB_PATH)} (${toErrorMessage(error)})`,
        ),
      );
      snapshot = {
        currentSessions: [],
        allSessionKeys: new Set<string>(),
      };
    }

    if (snapshotLoaded) {
      const orphanedExports = exportCandidates.filter((candidate) => {
        const sessionDirName = path.basename(candidate.path);
        return !snapshot.allSessionKeys.has(sessionDirName);
      });

      if (orphanedExports.length > 0) {
        const { freeBytes, critical } = readCriticalDiskState();
        results.push(
          makeResult(
            'disk',
            'Orphaned exports',
            critical ? 'error' : 'warn',
            formatCleanupMessage({
              count: orphanedExports.length,
              totalBytes: sumCandidateBytes(orphanedExports),
              oldestAgeMs: maxCandidateAgeMs(orphanedExports),
              freeBytes,
              note: 'session export directories no longer match any stored session',
            }),
            buildCleanupFix({
              summary: `Remove ${orphanedExports.length} orphaned export director${orphanedExports.length === 1 ? 'y' : 'ies'}`,
              candidates: orphanedExports,
              requiresApproval: critical,
            }),
          ),
        );
      } else {
        results.push(
          makeResult(
            'disk',
            'Orphaned exports',
            'ok',
            'No orphaned session exports older than 7d',
          ),
        );
      }
    }
  } else {
    results.push(
      makeResult(
        'disk',
        'Orphaned exports',
        'ok',
        'No orphaned session exports older than 7d',
      ),
    );
  }

  if (promptDumpCandidate) {
    const { freeBytes, critical } = readCriticalDiskState();
    results.push(
      makeResult(
        'disk',
        'Prompt dump',
        critical ? 'error' : 'warn',
        [
          `${promptDumpCandidate.displayPath} is older than ${formatAge(PROMPT_DUMP_MAX_AGE_MS)}`,
          `${formatBytes(promptDumpCandidate.sizeBytes)} reclaimable`,
          freeBytes != null ? `${formatBytes(freeBytes)} free` : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(', '),
        buildCleanupFix({
          summary: `Remove stale prompt dump at ${promptDumpCandidate.displayPath}`,
          candidates: [promptDumpCandidate],
          requiresApproval: critical,
        }),
      ),
    );
  } else {
    results.push(
      makeResult(
        'disk',
        'Prompt dump',
        'ok',
        `No prompt dump older than ${formatAge(PROMPT_DUMP_MAX_AGE_MS)}`,
      ),
    );
  }

  return results;
}

export function resourceHygieneDoctorChecks(): DoctorCheck[] {
  return [
    {
      category: 'disk',
      label: 'Stale workspaces',
      run: checkStaleWorkspaces,
    },
    {
      category: 'disk',
      label: 'Old temp media',
      run: checkOldTempMedia,
    },
    {
      category: 'disk',
      label: 'Old run logs',
      run: checkOldRunLogs,
    },
    {
      category: 'database',
      label: 'Session compaction backlog',
      run: checkSessionCompactionBacklog,
    },
    {
      category: 'disk',
      label: 'Orphaned exports / prompt dumps',
      run: checkOrphanedExportsAndPromptDumps,
    },
  ];
}
