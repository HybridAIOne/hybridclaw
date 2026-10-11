import type { Card } from '../../src/board/card-store.js';
import type { withMemoryDatabase } from '../../src/memory/db.js';

type CardFixture = Pick<Card, 'id' | 'title' | 'owner'> & Partial<Card>;

export function seedBoardCard(
  databaseModule: { withMemoryDatabase: typeof withMemoryDatabase },
  input: CardFixture,
): void {
  const timestamp = input.createdAt ?? new Date().toISOString();
  databaseModule.withMemoryDatabase((database) => {
    database
      .prepare(
        `INSERT INTO board_cards (
        id, title, body, owner, owner_type, owner_id, "column", status,
        source, parent, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.body ?? '',
        JSON.stringify(input.owner),
        input.owner.agentId ? 'agent' : 'user',
        input.owner.agentId ?? input.owner.userId,
        input.column ?? 'todo',
        input.status ?? 'queued',
        input.source ?? 'manual',
        input.parent ?? null,
        timestamp,
        input.updatedAt ?? timestamp,
        input.deletedAt ?? null,
      );
  });
}
