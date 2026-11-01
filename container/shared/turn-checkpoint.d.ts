import type { HistoryMessage } from './tool-history.js';

type CheckpointMessage = Omit<HistoryMessage, 'content'> & { content: unknown };

export interface TurnCheckpointData {
  version: 1;
  turnId: string;
  messages: HistoryMessage[];
  started: string[];
  assistantText?: string;
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
export function checkpointOutput(data: TurnCheckpointData): {
  status: 'error';
  result: null;
  error: string;
  toolsUsed: string[];
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
};
export class TurnCheckpoint {
  constructor(workspaceRoot: string, sessionId: string, turnId: string);
  readonly recovered: ReturnType<typeof checkpointOutput> | null;
  assistant(message: CheckpointMessage): void;
  start(id: string): void;
  result(message: CheckpointMessage): void;
}
