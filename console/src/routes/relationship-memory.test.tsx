import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type {
  MemoryRelationship,
  MemoryRelationshipDetail,
} from '../../../src/types/relationship-memory';
import { renderWithProviders } from '../test-utils';
import { RelationshipMemoryPage } from './relationship-memory';

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock('../api/relationship-memory', () => ({
  fetchMemoryRelationships: api.list,
  fetchMemoryRelationship: api.detail,
}));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));

const person: MemoryRelationship = {
  agentId: 'main',
  audienceKey: 'person_key',
  kind: 'person',
  peerId: 'user_a',
  channel: 'discord',
  sessionCount: 1,
  memoryCount: 1,
  lastActive: '2026-10-01',
};
const group: MemoryRelationship = {
  ...person,
  audienceKey: 'group_key',
  kind: 'group',
  peerId: 'group_a',
};
const detail: MemoryRelationshipDetail = {
  relationship: person,
  sessions: [
    {
      id: 'session_a',
      sessionKey: 'source_key',
      current: false,
      title: null,
      summary: 'Prefers morning meetings',
      summaryUpdatedAt: null,
    },
  ],
  nextSessionOffset: null,
  nextMemoryOffset: null,
  memories: [
    {
      id: 1,
      session_id: 'session_a',
      role: 'user',
      content: 'Prefers short replies',
      source: 'conversation',
      scope: 'fact',
      confidence: 0.8,
      source_message_id: 2,
      created_at: '2026-10-01',
      accessed_at: '2026-10-01',
      access_count: 0,
    },
  ],
  continuity: { summary: null, recent_messages: [] },
};
beforeEach(() => {
  api.list
    .mockReset()
    .mockResolvedValue({ relationships: [person, group], nextOffset: null });
  api.detail.mockReset().mockResolvedValue(detail);
});

test('switches people and groups and shows memory provenance for the selected audience', async () => {
  renderWithProviders(<RelationshipMemoryPage />);
  fireEvent.click(await screen.findByRole('button', { name: /user_a/ }));
  expect(await screen.findByText('Prefers short replies')).toBeTruthy();
  expect(screen.getByText('person_key')).toBeTruthy();
  expect(screen.getByText('source_key')).toBeTruthy();
  expect(api.detail).toHaveBeenCalledWith(
    'test-token',
    'main',
    'person_key',
    0,
    0,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Groups' }));
  expect(await screen.findByRole('button', { name: /group_a/ })).toBeTruthy();
  expect(screen.queryByText('Prefers short replies')).toBeNull();
});

test('searches loaded relationships and loads older pages', async () => {
  api.list.mockImplementation((_token: string, offset: number) =>
    Promise.resolve(
      offset === 0
        ? { relationships: [person], nextOffset: 50 }
        : {
            relationships: [
              { ...person, peerId: 'user_b', audienceKey: 'older_key' },
            ],
            nextOffset: null,
          },
    ),
  );
  renderWithProviders(<RelationshipMemoryPage />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Load more relationships' }),
  );
  expect(await screen.findByRole('button', { name: /user_b/ })).toBeTruthy();
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Search loaded relationships' }),
    { target: { value: 'user_b' } },
  );
  expect(screen.queryByRole('button', { name: /user_a/ })).toBeNull();
  expect(api.list).toHaveBeenCalledWith('test-token', 50);
});

test('shows API errors without displaying stale details', async () => {
  api.detail.mockRejectedValue(new Error('Relationship not found'));
  renderWithProviders(<RelationshipMemoryPage />);
  fireEvent.click(await screen.findByRole('button', { name: /user_a/ }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Relationship not found',
  );
  expect(screen.queryByText('Prefers short replies')).toBeNull();
});
