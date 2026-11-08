import type { TokenUsageStats } from './token-usage.js';
import type { HistoryMessage } from './tool-history.js';

type CheckpointMessage = Omit<HistoryMessage, 'content'> & { content: unknown };

export interface TurnCheckpointData {
  version: 1;
  turnId: string;
  messages: HistoryMessage[];
  started: string[];
  assistantText?: string;
  tokenUsage?: TokenUsageStats;
}
export function sessionStateKey(sessionId: string): string;
export function sessionStatePath(
  workspaceRoot: string,
  sessionId: string,
  name: string,
): string;
export function turnCheckpointPath(
  workspaceRoot: string,
  sessionId: string,
): string;
export function readTurnCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  maxBytes?: number,
): TurnCheckpointData | null;
export type RecoveryDisposition =
  | { kind: 'refused'; turnId?: string }
  | {
      kind: 'recovered';
      turnId: string;
      calls: Array<{
        messageIndex: number;
        toolCallId: string;
        outcome: 'result_recorded' | 'outcome_unknown' | 'not_executed';
      }>;
    };

/** Conversation evidence cannot carry executable approvals or queued effects. */
export interface TurnRecoveryEvidence {
  recovery: RecoveryDisposition & { kind: 'recovered'; turnId: string };
  pendingApproval?: never;
  sideEffects?: never;
  approvalReply?: never;
  status: 'error';
  result: null;
  error: string;
  toolsUsed: string[];
  tokenUsage?: TokenUsageStats;
  toolHistory: HistoryMessage[];
  toolHistoryForReplay: HistoryMessage[];
  toolExecutions: Array<{
    name: string;
    arguments: string;
    toolCallId: string;
    result: string;
    isError: boolean;
    durationMs: number;
  }>;
}
export function checkpointOutput(
  data: TurnCheckpointData,
): TurnRecoveryEvidence;
export type TurnRecoveryResult =
  | { kind: 'recovered'; evidence: TurnRecoveryEvidence }
  | { kind: 'refused'; reason: 'missing' | 'run_mismatch' | 'unreadable' };
export function readTurnRecovery(
  workspaceRoot: string,
  sessionId: string,
  turnId: string,
  maxBytes?: number,
): TurnRecoveryResult;
export class TurnCheckpoint {
  constructor(workspaceRoot: string, sessionId: string, turnId: string);
  readonly recovered: ReturnType<typeof checkpointOutput> | null;
  usage(stats: TokenUsageStats): void;
  snapshot(): TurnRecoveryEvidence;
  assistant(message: CheckpointMessage): void;
  start(id: string): void;
  result(message: CheckpointMessage): void;
}
