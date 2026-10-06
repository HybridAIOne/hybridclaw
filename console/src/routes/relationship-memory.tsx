/**
 * Memory inspection keeps selection tied to an agent and stored audience key.
 * Unlike the chat surface, this operator view shows provenance across retired
 * sessions and never implies workspace notes have a private audience.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { MemoryRelationship } from '../../../src/types/relationship-memory';
import {
  fetchMemoryRelationship,
  fetchMemoryRelationships,
} from '../api/relationship-memory';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { Input } from '../components/input';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import styles from './relationship-memory.module.css';

const RELATIONSHIP_TABS: Record<MemoryRelationship['kind'], string> = {
  person: 'People',
  group: 'Groups',
  session: 'Sessions',
};

export function RelationshipMemoryPage() {
  const { token } = useAuth();
  const [kind, setKind] = useState<MemoryRelationship['kind']>('person');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<MemoryRelationship | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['memory-relationships', token],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchMemoryRelationships(token, pageParam),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });
  const relationships = (
    list.data?.pages.flatMap((page) => page.relationships) ?? []
  ).filter(
    (r) =>
      r.kind === kind &&
      `${r.agentId} ${r.peerId ?? ''} ${r.channel ?? ''} ${r.audienceKey}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader description="What Hy remembers about each relationship and where that memory belongs." />
      <p className="supporting-text">
        This is an operator view. Conversation memories stay within their stored
        session; continuity uses the audience key shown below. MEMORY.md and
        daily workspace notes are shared across an agent’s sessions and do not
        have person or group access boundaries.
      </p>
      <fieldset className={styles.tabs} aria-label="Relationship type">
        {(
          Object.entries(RELATIONSHIP_TABS) as Array<
            [MemoryRelationship['kind'], string]
          >
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={kind === value ? 'default' : 'outline'}
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value);
              setSelected(null);
            }}
          >
            {label}
          </Button>
        ))}
      </fieldset>
      <Input
        aria-label="Search loaded relationships"
        placeholder="Search loaded relationships by peer, channel, or agent"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {list.isPending && (
        <div className="empty-state">Loading relationships…</div>
      )}
      {list.error && <div role="alert">{getErrorMessage(list.error)}</div>}
      <div className={styles.layout}>
        <div className={styles.list}>
          {!list.isPending && !list.error && relationships.length === 0 && (
            <p className="empty-state">
              No matching relationships loaded.
              {list.hasNextPage ? ' Load more to see older relationships.' : ''}
            </p>
          )}
          {relationships.map((r) => (
            <button
              type="button"
              className={styles.relationship}
              key={`${r.agentId}:${r.audienceKey}`}
              aria-pressed={
                selected?.agentId === r.agentId &&
                selected.audienceKey === r.audienceKey
              }
              onClick={() => setSelected(r)}
            >
              <strong>{r.peerId ?? r.audienceKey}</strong>
              <span>
                {r.agentId} · {r.channel ?? 'Unclassified audience'}
              </span>
              <span>
                {r.memoryCount} memories · {r.sessionCount} sessions
              </span>
            </button>
          ))}
          {list.hasNextPage && (
            <Button
              variant="outline"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Load more relationships
            </Button>
          )}
        </div>
        {selected ? (
          <RelationshipDetail
            key={`${selected.agentId}:${selected.audienceKey}`}
            relationship={selected}
            token={token}
          />
        ) : (
          <p className="empty-state">
            Select a relationship to inspect its memory and audience.
          </p>
        )}
      </div>
    </>
  );
}

function RelationshipDetail({
  relationship,
  token,
}: {
  relationship: MemoryRelationship;
  token: string;
}) {
  const [sessionOffset, setSessionOffset] = useState(0);
  const [memoryOffset, setMemoryOffset] = useState(0);
  const detail = useQuery({
    queryKey: [
      'memory-relationship',
      token,
      relationship.agentId,
      relationship.audienceKey,
      sessionOffset,
      memoryOffset,
    ],
    queryFn: () =>
      fetchMemoryRelationship(
        token,
        relationship.agentId,
        relationship.audienceKey,
        sessionOffset,
        memoryOffset,
      ),
  });
  if (detail.isPending)
    return <div className="empty-state">Loading memory…</div>;
  if (detail.error)
    return <div role="alert">{getErrorMessage(detail.error)}</div>;
  const data = detail.data;
  return (
    <div className={styles.detail}>
      <Card>
        <CardHeader>
          <CardTitle>Audience boundary</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            {relationship.kind === 'person'
              ? 'Direct conversation audience'
              : relationship.kind === 'group'
                ? 'Shared conversation audience'
                : 'Unclassified session audience — privacy cannot be inferred'}
          </p>
          <p>
            Agent: <strong>{relationship.agentId}</strong>
          </p>
          <code className={styles.key}>{relationship.audienceKey}</code>
          <p className="supporting-text">
            Source session keys below show the channels and threads included in
            this stored relationship. Linked identities appear together only
            when their sessions already share this audience key. A memory’s
            “scope” describes its category, not who can access it.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            Remembered facts and episodes ({data.relationship.memoryCount})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.memories.length === 0 && <p>No stored semantic memories.</p>}
          {data.memories.map((m) => (
            <article className={styles.entry} key={m.id}>
              <p className={styles.content}>{m.content}</p>
              <small>
                #{m.id} · {m.source} · {m.scope} ·{' '}
                {Math.round(m.confidence * 100)}% stored confidence
              </small>
              <small>
                Session {m.session_id}
                {m.source_message_id !== null
                  ? ` · message ${m.source_message_id}`
                  : ''}{' '}
                · {m.created_at}
              </small>
            </article>
          ))}
          <div className="button-row">
            <Button
              variant="outline"
              disabled={memoryOffset === 0}
              onClick={() => setMemoryOffset(0)}
            >
              Newest memories
            </Button>
            {data.nextMemoryOffset !== null && (
              <Button
                variant="outline"
                onClick={() => setMemoryOffset(data.nextMemoryOffset ?? 0)}
              >
                Older memories
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Conversation summaries and sources</CardTitle>
        </CardHeader>
        <CardContent>
          {data.sessions.map((s) => (
            <article className={styles.entry} key={s.id}>
              <strong>
                {s.title ?? s.id} · {s.current ? 'Current' : 'Retired'}
              </strong>
              <code className={styles.key}>{s.sessionKey}</code>
              <small>
                Session {s.id}
                {s.summaryUpdatedAt
                  ? ` · summary updated ${s.summaryUpdatedAt}`
                  : ''}
              </small>
              <p className={styles.content}>
                {s.summary || 'No conversation summary stored.'}
              </p>
            </article>
          ))}
          <div className="button-row">
            <Button
              variant="outline"
              disabled={sessionOffset === 0}
              onClick={() => setSessionOffset(0)}
            >
              Latest sessions
            </Button>
            {data.nextSessionOffset !== null && (
              <Button
                variant="outline"
                onClick={() => setSessionOffset(data.nextSessionOffset ?? 0)}
              >
                Older sessions
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Relationship continuity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className={styles.content}>
            {data.continuity.summary || 'No continuity summary stored.'}
          </p>
          {data.continuity.recent_messages.map((m) => (
            <article
              className={styles.entry}
              key={`${m.session_id}:${m.created_at}:${m.role}:${m.content}`}
            >
              <small>
                {m.role} · session {m.session_id} · {m.created_at}
              </small>
              <p className={styles.content}>{m.content}</p>
            </article>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
