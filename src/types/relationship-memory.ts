/**
 * Operator memory views describe persisted audience boundaries without granting
 * recall access. Unlike semantic scope (episodic/fact), audience is a session
 * routing key; gateway and console share this read-only contract.
 */
import type { SemanticMemoryEntry } from './memory.js';
import type { CanonicalSessionContext } from './session.js';

export const RELATIONSHIP_MEMORY_PATH = '/api/admin/memory/relationships';

export interface MemoryRelationship {
  agentId: string;
  audienceKey: string;
  kind: 'person' | 'group' | 'session';
  peerId: string | null;
  channel: string | null;
  sessionCount: number;
  memoryCount: number;
  lastActive: string;
}

export interface MemoryRelationshipPage {
  relationships: MemoryRelationship[];
  nextOffset: number | null;
}

export interface MemoryRelationshipDetail {
  relationship: MemoryRelationship;
  sessions: Array<{
    id: string;
    sessionKey: string;
    title: string | null;
    current: boolean;
    summary: string | null;
    summaryUpdatedAt: string | null;
  }>;
  nextSessionOffset: number | null;
  memories: Omit<SemanticMemoryEntry, 'embedding' | 'metadata'>[];
  nextMemoryOffset: number | null;
  continuity: CanonicalSessionContext;
}
