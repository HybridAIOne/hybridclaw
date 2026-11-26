/**
 * Worker process — wraps one spawned worker child in its pool entry and turns
 * its stderr and exit into lifecycle signals and redacted callbacks.
 *
 * Every delta, preview and approval text is redacted before a callback sees
 * it, and a throwing callback never breaks the stream. Exit or spawn failure
 * always removes the entry, so a dead worker is never handed a request.
 * NOT the IPC result path (`ipc.ts`) and not the spawn itself: the strategy
 * starts the child, this only listens to it.
 */
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { generateIpcAuthSecret } from '@hybridclaw/shared/ipc-input-auth';
import type { ExecutorSessionHealthSnapshot } from '../agent/executor-types.js';
import { logger } from '../logger.js';
import { redactCredentialSecrets } from '../security/redact.js';
import type { PendingApproval, ToolProgressEvent } from '../types/execution.js';
import { parseApprovalProgress } from './approval-progress.js';
import { removeUnclaimedWarmSessionDir } from './ipc.js';
import { consumeModelResponseDebugFileLine } from './model-response-debug.js';
import {
  consumeCollapsedStreamDebugLine,
  createStreamDebugState,
  decodeStreamDelta,
  decodeThinkingDelta,
  flushCollapsedStreamDebugSummary,
  isStreamActivityLine,
  isThinkingDeltaLine,
  type StreamDebugState,
} from './stream-debug.js';
import { parseToolProgressLine } from './tool-progress-parser.js';
import type { WarmProcessPool } from './warm-process-pool.js';
import {
  formatWarmRunnerTerminalError,
  observeAgentLifecycleLine,
  rememberStderrLine,
  type WarmRunnerEntry,
} from './warm-runner-utils.js';
import {
  type BrowserFrameSink,
  stashBrowserFrameLine,
  stashSlideSamplesLine,
  takeBrowserFrame,
  takeSlideSamples,
} from './worker-artifacts.js';
import { WorkerLifecycle } from './worker-lifecycle.js';
import type { WorkerStrategy } from './worker-runner.js';

export interface WorkerEntry extends WarmRunnerEntry, BrowserFrameSink {
  process: ChildProcess;
  /** Strategy-assigned worker name (the Docker container name). */
  name?: string;
  sessionId: string;
  ipcSessionId: string;
  agentId: string;
  startedAt: number;
  lastUsedAt: number;
  pendingColdStartProbeStartedAt: number | null;
  stderrBuffer: string;
  stderrHistory: string[];
  streamDebug: StreamDebugState;
  workerSignature: string;
  /** Per-worker secret sent once via stdin; authenticates later IPC inputs. */
  ipcAuthSecret: string;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onApprovalProgress?: (approval: PendingApproval) => void;
  healthProbe?: Promise<ExecutorSessionHealthSnapshot>;
}

export function isStdinWriteInterrupt(
  error: unknown,
  proc: Pick<ChildProcess, 'killed' | 'exitCode'>,
  abortSignal?: AbortSignal,
): boolean {
  if (abortSignal?.aborted) return true;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  return (
    (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') &&
    (proc.killed || proc.exitCode !== null)
  );
}

function emitDelta(
  entry: WorkerEntry,
  callback: ((delta: string) => void) | undefined,
  delta: string | null,
  label: string,
): void {
  if (!callback || !delta) return;
  try {
    callback(redactCredentialSecrets(delta));
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      `${label} callback failed`,
    );
  }
}

function emitToolProgress(entry: WorkerEntry, line: string): void {
  const callback = entry.onToolProgress;
  if (!callback) return;
  if (stashBrowserFrameLine(entry, line)) return;
  if (stashSlideSamplesLine(entry, line)) return;
  const parsed = parseToolProgressLine(line);
  if (!parsed) return;
  const browser = takeBrowserFrame(entry, parsed.toolName, parsed.phase);
  const slideSamples = takeSlideSamples(entry, parsed.toolName, parsed.phase);

  try {
    callback({
      sessionId: entry.sessionId,
      ...parsed,
      preview: redactCredentialSecrets(parsed.preview || ''),
      ...(browser ? { browser } : {}),
      ...(slideSamples ? { slideSamples } : {}),
    });
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      'Tool progress callback failed',
    );
  }
}

function emitApprovalProgress(entry: WorkerEntry, line: string): boolean {
  const approval = parseApprovalProgress(line);
  if (!approval) return false;
  if (!entry.onApprovalProgress) return true;
  try {
    entry.onApprovalProgress(approval);
  } catch (err) {
    logger.debug(
      { sessionId: entry.sessionId, err },
      'Approval progress callback failed',
    );
  }
  return true;
}

function emitStreamDeltas(entry: WorkerEntry, line: string): void {
  emitDelta(entry, entry.onTextDelta, decodeStreamDelta(line), 'Text delta');
  emitDelta(
    entry,
    entry.onThinkingDelta,
    decodeThinkingDelta(line),
    'Thinking delta',
  );
}
/**
 * Handles one trimmed stderr line. `final` marks the unterminated tail read at
 * exit, which only a thinking delta counts as activity for.
 */
function handleStderrLine(
  entry: WorkerEntry,
  line: string,
  warmPool: WarmProcessPool<WorkerEntry>,
  logFields: Record<string, unknown>,
  final: boolean,
): void {
  if (observeAgentLifecycleLine(entry, line, warmPool)) return;
  if (consumeModelResponseDebugFileLine(line) || isStreamActivityLine(line)) {
    entry.lifecycle.activity?.notify();
    return;
  }
  rememberStderrLine(entry, line);
  emitStreamDeltas(entry, line);
  const thinking = isThinkingDeltaLine(line);
  if (
    !thinking &&
    !consumeCollapsedStreamDebugLine(line, entry.streamDebug, (message) =>
      logger.debug(logFields, message),
    ) &&
    !emitApprovalProgress(entry, line)
  ) {
    logger.debug(logFields, line);
    emitToolProgress(entry, line);
  }
  if (!final || thinking) entry.lifecycle.activity?.notify();
}

export function capitalize(text: string): string {
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

/** Builds the entry for a freshly spawned worker and wires its stdio. */
export function createWorkerEntry(params: {
  strategy: WorkerStrategy;
  spawned: { process: ChildProcess; name?: string };
  sessionId: string;
  agentId: string;
  warm: boolean;
  warmPool: WarmProcessPool<WorkerEntry>;
  stop: (entry: WorkerEntry) => void;
  remove: (entry: WorkerEntry) => void;
}): WorkerEntry {
  const { strategy, sessionId } = params;
  const proc = params.spawned.process;
  const worker = strategy.noun.one;
  const entry: WorkerEntry = {
    id: sessionId,
    process: proc,
    name: params.spawned.name,
    get sessionId() {
      return entry.lifecycle.owner.kind === 'session'
        ? entry.lifecycle.owner.sessionId
        : sessionId;
    },
    ipcSessionId: sessionId,
    agentId: params.agentId,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    lifecycle: new WorkerLifecycle(params.warm ? null : sessionId),
    pendingColdStartProbeStartedAt: null,
    stderrBuffer: '',
    stderrHistory: [],
    streamDebug: createStreamDebugState(),
    workerSignature: '',
    ipcAuthSecret: generateIpcAuthSecret(),
    isReady() {
      return entry.lifecycle.phase === 'idle';
    },
    stop() {
      params.stop(entry);
    },
  };
  const fields = { sessionId, ...strategy.logFields(entry) };
  const logDebug = (message: string) => logger.debug(fields, message);

  // Listen before touching stdio: on EMFILE/ENFILE, spawn returns a child
  // without stdio and emits 'error' next tick, fatal if nobody listens.
  proc.on('error', (err) => {
    entry.lifecycle.exit(
      `${strategy.runtimeLabel} failed before producing output: ${err instanceof Error ? err.message : String(err)}`,
    );
    params.remove(entry);
    logger.error({ ...fields, error: err }, `${capitalize(worker)} error`);
  });
  if (!proc.stderr) {
    throw new Error('stdio pipes not created (out of file descriptors)');
  }

  // One decoder per pipe: a chunk can end inside a multi-byte character.
  const stderrDecoder = new StringDecoder('utf8');
  proc.stderr.on('data', (data) => {
    entry.stderrBuffer += stderrDecoder.write(data);
    const lines = entry.stderrBuffer.split('\n');
    entry.stderrBuffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line) handleStderrLine(entry, line, params.warmPool, fields, false);
    }
  });

  proc.on('close', (code, signal) => {
    const tail = entry.stderrBuffer.trim();
    if (tail) {
      handleStderrLine(entry, tail, params.warmPool, fields, true);
      entry.stderrBuffer = '';
    }
    entry.lifecycle.exit(
      formatWarmRunnerTerminalError(entry, strategy.runtimeLabel, {
        code,
        signal,
        repairHint: strategy.repairHint,
      }),
    );
    flushCollapsedStreamDebugSummary(entry.streamDebug, logDebug);
    params.remove(entry);
    if (entry.lifecycle.isSpare)
      removeUnclaimedWarmSessionDir(entry.ipcSessionId);
    logger.info({ ...fields, code, signal }, `${capitalize(worker)} exited`);
  });

  if (strategy.guardsStdinErrors) {
    proc.stdin?.on('error', (err) => {
      if (isStdinWriteInterrupt(err, proc)) {
        logger.debug(
          { ...fields, error: err },
          `Ignoring ${worker} stdin error after process shutdown`,
        );
        return;
      }
      logger.error(
        { ...fields, error: err },
        `${capitalize(worker)} stdin error`,
      );
    });
  }
  return entry;
}
