/**
 * Agent workers for OpenAI-compatible requests: requests that share a seed
 * (same caller, agent, model, profile and conversation start) reuse a warm
 * worker for 30 s; the rest get a one-off worker stopped when they finish.
 * Capped at the container limit by evicting idle workers first. NOT the
 * request's chat session, which every request creates fresh.
 */
import { createHash, randomUUID } from 'node:crypto';
import { stopSessionExecution } from '../agent/executor.js';
import { MAX_CONCURRENT_CONTAINERS } from '../config/config.js';
import { buildSessionKey } from '../session/session-key.js';

const OPENAI_EXECUTION_SESSION_TTL_MS = 30_000;

interface OpenAIExecutionSessionEntry {
  sessionId: string;
  inFlight: number;
  lastUsedAt: number;
}

export interface OpenAIExecutionSession {
  sessionId: string;
  stopOnFinish: boolean;
  release: () => void;
}

const openAIExecutionSessions = new Map<string, OpenAIExecutionSessionEntry>();

function buildOpenAIExecutionSessionId(agentId: string, seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return buildSessionKey(agentId, 'openai', 'dm', `exec-${digest}`);
}

function oneOffOpenAIExecutionSession(agentId: string): OpenAIExecutionSession {
  return {
    sessionId: buildSessionKey(
      agentId,
      'openai',
      'dm',
      randomUUID().replace(/-/g, '').slice(0, 16),
    ),
    stopOnFinish: true,
    release: () => {},
  };
}

function reapExpiredOpenAIExecutionSessions(now = Date.now()): void {
  for (const [key, entry] of openAIExecutionSessions) {
    if (
      entry.inFlight === 0 &&
      now - entry.lastUsedAt > OPENAI_EXECUTION_SESSION_TTL_MS
    ) {
      stopSessionExecution(entry.sessionId);
      openAIExecutionSessions.delete(key);
    }
  }
}

function evictOldestIdleOpenAIExecutionSession(): boolean {
  let oldestKey: string | null = null;
  let oldestEntry: OpenAIExecutionSessionEntry | null = null;
  for (const [key, entry] of openAIExecutionSessions) {
    if (entry.inFlight > 0) continue;
    if (!oldestEntry || entry.lastUsedAt < oldestEntry.lastUsedAt) {
      oldestKey = key;
      oldestEntry = entry;
    }
  }
  if (!oldestKey || !oldestEntry) return false;
  stopSessionExecution(oldestEntry.sessionId);
  openAIExecutionSessions.delete(oldestKey);
  return true;
}

/**
 * Execution session for one OpenAI-compatible request. Requests with the same
 * seed reuse a warm session; ephemeral requests always get a one-off session
 * that is stopped when they finish.
 */
export function acquireOpenAIExecutionSession(params: {
  agentId: string;
  seed: string;
  ephemeral: boolean;
}): OpenAIExecutionSession {
  if (params.ephemeral) return oneOffOpenAIExecutionSession(params.agentId);

  const now = Date.now();
  reapExpiredOpenAIExecutionSessions(now);
  let entry = openAIExecutionSessions.get(params.seed);
  if (!entry) {
    let evictedIdleSession = false;
    while (
      openAIExecutionSessions.size >= MAX_CONCURRENT_CONTAINERS &&
      evictOldestIdleOpenAIExecutionSession()
    ) {
      evictedIdleSession = true;
      // Make room by evicting idle reusable OpenAI execution sessions first.
    }
    if (
      openAIExecutionSessions.size >= MAX_CONCURRENT_CONTAINERS &&
      !evictedIdleSession
    ) {
      return oneOffOpenAIExecutionSession(params.agentId);
    }
    entry = {
      sessionId: buildOpenAIExecutionSessionId(params.agentId, params.seed),
      inFlight: 0,
      lastUsedAt: now,
    };
    openAIExecutionSessions.set(params.seed, entry);
  }
  entry.inFlight += 1;
  entry.lastUsedAt = now;
  const seed = params.seed;
  return {
    sessionId: entry.sessionId,
    stopOnFinish: false,
    release: () => {
      const current = openAIExecutionSessions.get(seed);
      if (!current) return;
      current.inFlight = Math.max(0, current.inFlight - 1);
      current.lastUsedAt = Date.now();
    },
  };
}
