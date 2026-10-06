import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { appendCanonicalMessages } from '../src/memory/canonical-sessions.js';
import { closeDatabase, initDatabase, withMemoryDatabase } from '../src/memory/database.js';
import { inspectMemoryRelationship, listMemoryRelationships, RELATIONSHIP_MEMORY_PAGE_SIZE } from '../src/memory/relationship-memory.js';
import { forgetSemanticMemory, listSemanticMemoriesForSession, storeSemanticMemory } from '../src/memory/semantic-memory.js';
import { getOrCreateSession } from '../src/memory/sessions.js';
import { buildSessionKey } from '../src/session/session-key.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir('relationship-memory-');
useCleanMocks({ cleanup: closeDatabase });
beforeEach(() => initDatabase({ quiet: true, dbPath: path.join(tempDir(), 'memory.db') }));

function session(peer: string, chat = 'dm', agent = 'main', options?: { threadId: string }) {
  const key = buildSessionKey(agent, 'discord', chat, peer, options);
  return getOrCreateSession(key, chat === 'dm' ? null : 'guild_a', peer, agent);
}
function remember(id: string, content = 'Prefers short replies') {
  return storeSemanticMemory({ sessionId: id, role: 'user', content, scope: 'fact', confidence: 0.8 });
}

describe('relationship memory inspection', () => {
  test('keeps people, groups, threads and agents separate, without matching prose', () => {
    const person = session('user_a');
    const group = session('group_a', 'group');
    const thread = session('group_a', 'group', 'main', { threadId: 'thread_a' });
    const otherAgent = session('user_a', 'dm', 'writer');
    for (const s of [person, group, thread, otherAgent]) remember(s.id, 'About user_a and group_a');
    const rows = listMemoryRelationships().relationships;
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.kind === 'person')).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'group')).toHaveLength(2);
    const detail = inspectMemoryRelationship({ agentId: 'main', audienceKey: person.main_session_key });
    expect(detail?.memories.map((m) => m.session_id)).toEqual([person.id]);
    expect(inspectMemoryRelationship({ agentId: 'writer', audienceKey: person.main_session_key })).toBeNull();
  });

  test('includes retired instances and continuity, excludes deleted memories and does not touch access', () => {
    const first = session('user_a');
    remember(first.id);
    const deleted = remember(first.id, 'Deleted fact');
    forgetSemanticMemory(deleted);
    const current = getOrCreateSession(first.session_key, null, 'user_a', 'main', { forceNewCurrent: true });
    remember(current.id, 'New fact');
    appendCanonicalMessages({ agentId: 'main', userId: first.main_session_key,
      newMessages: [{ role: 'user', content: 'Earlier continuity', sessionId: first.id }] });
    const before = listSemanticMemoriesForSession(first.id);
    const detail = inspectMemoryRelationship({ agentId: 'main', audienceKey: first.main_session_key });
    expect(detail?.relationship).toMatchObject({ sessionCount: 2, memoryCount: 2 });
    expect(detail?.sessions.map((s) => [s.id, s.current])).toEqual(expect.arrayContaining([[first.id, false], [current.id, true]]));
    expect(detail?.memories.map((m) => m.id)).not.toContain(deleted);
    expect(detail?.continuity.recent_messages[0].content).toBe('Earlier continuity');
    expect(listSemanticMemoriesForSession(first.id)).toEqual(before);
    expect(detail?.memories[0]).not.toHaveProperty('embedding');
    expect(detail?.memories[0]).not.toHaveProperty('metadata');
  });

  test('uses persisted linked audiences without guessing new links or including other peers', () => {
    const a = session('user_a');
    const b = session('user_b');
    const c = session('user_c');
    const audience = buildSessionKey('main', 'main', 'dm', 'linked_a');
    withMemoryDatabase((db) => db.prepare('UPDATE sessions SET main_session_key = ? WHERE id IN (?, ?)').run(audience, a.id, b.id));
    for (const s of [a, b, c]) remember(s.id);
    const detail = inspectMemoryRelationship({ agentId: 'main', audienceKey: audience });
    expect(detail?.relationship).toMatchObject({ kind: 'person', peerId: 'linked_a', sessionCount: 2 });
    expect(detail?.sessions.map((s) => s.sessionKey).sort()).toEqual([a.session_key, b.session_key].sort());
    expect(detail?.memories.map((m) => m.session_id)).not.toContain(c.id);
  });

  test('leaves opaque and malformed audiences unclassified', () => {
    getOrCreateSession('opaque_a', null, 'web', 'main');
    const s = session('user_a');
    withMemoryDatabase((db) => db.prepare('UPDATE sessions SET main_session_key = ? WHERE id = ?').run('agent:broken', s.id));
    expect(listMemoryRelationships().relationships.map((r) => r.kind)).toEqual(['session', 'session']);
  });

  test('paginates relationships and detail without silently dropping older memories', () => {
    const a = session('user_a');
    for (let i = 0; i <= RELATIONSHIP_MEMORY_PAGE_SIZE; i++) {
      session(`peer_${i}`);
      remember(a.id, `Fact ${i}`);
    }
    const first = listMemoryRelationships();
    expect(first.relationships).toHaveLength(RELATIONSHIP_MEMORY_PAGE_SIZE);
    expect(first.nextOffset).toBe(RELATIONSHIP_MEMORY_PAGE_SIZE);
    const second = listMemoryRelationships(first.nextOffset ?? 0);
    expect(second.relationships).toHaveLength(2);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.relationships, ...second.relationships].map((r) => r.audienceKey)).size).toBe(52);
    const detail = inspectMemoryRelationship({ agentId: 'main', audienceKey: a.main_session_key });
    expect(detail?.memories).toHaveLength(RELATIONSHIP_MEMORY_PAGE_SIZE);
    const older = inspectMemoryRelationship({ agentId: 'main', audienceKey: a.main_session_key, memoryOffset: detail?.nextMemoryOffset ?? 0 });
    expect(older?.memories).toHaveLength(1);
    expect(older?.nextMemoryOffset).toBeNull();
  });
});
