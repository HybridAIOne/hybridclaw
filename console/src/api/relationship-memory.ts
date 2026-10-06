/**
 * Operator memory inspection shares the gateway contract. This client never
 * feeds another relationship's memories into a chat or changes recall scope.
 */
import {
  type MemoryRelationshipDetail,
  type MemoryRelationshipPage,
  RELATIONSHIP_MEMORY_PATH,
} from '../../../src/types/relationship-memory';
import { requestJson } from './client';

export function fetchMemoryRelationships(token: string, offset: number) {
  return requestJson<MemoryRelationshipPage>(
    `${RELATIONSHIP_MEMORY_PATH}?offset=${offset}`,
    { token },
  );
}

export function fetchMemoryRelationship(
  token: string,
  agentId: string,
  audienceKey: string,
  sessionOffset: number,
  memoryOffset: number,
) {
  const query = new URLSearchParams({
    agentId,
    audienceKey,
    sessionOffset: String(sessionOffset),
    memoryOffset: String(memoryOffset),
  });
  return requestJson<MemoryRelationshipDetail>(
    `${RELATIONSHIP_MEMORY_PATH}?${query}`,
    { token },
  );
}
