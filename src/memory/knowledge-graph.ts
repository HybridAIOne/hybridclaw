import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type KnowledgeEntity,
  KnowledgeEntityType,
  type KnowledgeEntityTypeValue,
  type KnowledgeGraphMatch,
  type KnowledgeGraphPattern,
  KnowledgeRelationType,
  type KnowledgeRelationTypeValue,
} from '../types/knowledge.js';
import { withMemoryDatabase } from './database.js';
import { queryAll } from './sqlite.js';

function createKnowledgeGraphStore(database: Database.Database) {
  type RawKnowledgeGraphRow = {
    s_id: KnowledgeEntity['id'];
    s_type: string;
    s_name: KnowledgeEntity['name'];
    s_properties: string;
    s_created_at: KnowledgeEntity['created_at'];
    s_updated_at: KnowledgeEntity['updated_at'];
    r_id: string;
    r_source: KnowledgeEntity['id'];
    r_type: string;
    r_target: KnowledgeEntity['id'];
    r_properties: string;
    r_confidence: number;
    r_created_at: string;
    t_id: KnowledgeEntity['id'];
    t_type: string;
    t_name: KnowledgeEntity['name'];
    t_properties: string;
    t_created_at: KnowledgeEntity['created_at'];
    t_updated_at: KnowledgeEntity['updated_at'];
  };

  function normalizeKnowledgeCustomValue(raw: string): string {
    const value = raw.trim().toLowerCase();
    return value || 'unknown';
  }

  function normalizeEntityType(
    entityType: KnowledgeEntityTypeValue | string,
  ): KnowledgeEntityTypeValue {
    if (typeof entityType === 'object' && entityType) {
      if (typeof entityType.custom === 'string') {
        return { custom: normalizeKnowledgeCustomValue(entityType.custom) };
      }
      return { custom: 'unknown' };
    }

    const normalized = normalizeKnowledgeCustomValue(entityType);
    switch (normalized) {
      case 'person':
        return KnowledgeEntityType.Person;
      case 'organization':
      case 'org':
        return KnowledgeEntityType.Organization;
      case 'project':
        return KnowledgeEntityType.Project;
      case 'concept':
        return KnowledgeEntityType.Concept;
      case 'event':
        return KnowledgeEntityType.Event;
      case 'location':
        return KnowledgeEntityType.Location;
      case 'document':
      case 'doc':
        return KnowledgeEntityType.Document;
      case 'tool':
        return KnowledgeEntityType.Tool;
      default:
        return { custom: normalized };
    }
  }

  function normalizeRelationType(
    relation: KnowledgeRelationTypeValue | string,
  ): KnowledgeRelationTypeValue {
    if (typeof relation === 'object' && relation) {
      if (typeof relation.custom === 'string') {
        return { custom: normalizeKnowledgeCustomValue(relation.custom) };
      }
      return { custom: 'unknown' };
    }

    const normalized = normalizeKnowledgeCustomValue(relation)
      .replace(/[\s-]+/g, '_')
      .replace(/_+/g, '_');
    switch (normalized) {
      case 'works_at':
      case 'worksat':
        return KnowledgeRelationType.WorksAt;
      case 'knows_about':
      case 'knowsabout':
      case 'knows':
        return KnowledgeRelationType.KnowsAbout;
      case 'related_to':
      case 'relatedto':
      case 'related':
        return KnowledgeRelationType.RelatedTo;
      case 'depends_on':
      case 'dependson':
      case 'depends':
        return KnowledgeRelationType.DependsOn;
      case 'owned_by':
      case 'ownedby':
        return KnowledgeRelationType.OwnedBy;
      case 'created_by':
      case 'createdby':
        return KnowledgeRelationType.CreatedBy;
      case 'located_in':
      case 'locatedin':
        return KnowledgeRelationType.LocatedIn;
      case 'part_of':
      case 'partof':
        return KnowledgeRelationType.PartOf;
      case 'uses':
        return KnowledgeRelationType.Uses;
      case 'produces':
        return KnowledgeRelationType.Produces;
      default:
        return { custom: normalized };
    }
  }

  function serializeEntityType(
    entityType: KnowledgeEntityTypeValue | string,
  ): string {
    const normalized = normalizeEntityType(entityType);
    return typeof normalized === 'string'
      ? JSON.stringify(normalized)
      : JSON.stringify({ custom: normalized.custom });
  }

  function serializeRelationType(
    relation: KnowledgeRelationTypeValue | string,
  ): string {
    const normalized = normalizeRelationType(relation);
    return typeof normalized === 'string'
      ? JSON.stringify(normalized)
      : JSON.stringify({ custom: normalized.custom });
  }

  function parseEntityType(
    raw: string | null | undefined,
  ): KnowledgeEntityTypeValue {
    const value = (raw || '').trim();
    if (!value) return { custom: 'unknown' };

    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'string') return normalizeEntityType(parsed);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { custom?: unknown }).custom === 'string'
      ) {
        return normalizeEntityType({
          custom: (parsed as { custom: string }).custom,
        });
      }
    } catch {
      return normalizeEntityType(value);
    }

    return { custom: 'unknown' };
  }

  function parseRelationType(
    raw: string | null | undefined,
  ): KnowledgeRelationTypeValue {
    const value = (raw || '').trim();
    if (!value) return { custom: 'unknown' };

    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'string') return normalizeRelationType(parsed);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { custom?: unknown }).custom === 'string'
      ) {
        return normalizeRelationType({
          custom: (parsed as { custom: string }).custom,
        });
      }
    } catch {
      return normalizeRelationType(value);
    }

    return { custom: 'unknown' };
  }

  function serializeKnowledgeProperties(
    properties: Record<string, unknown> | null | undefined,
  ): string {
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    ) {
      return '{}';
    }
    try {
      return JSON.stringify(properties);
    } catch {
      return '{}';
    }
  }

  function parseKnowledgeProperties(raw: unknown): Record<string, unknown> {
    const text = Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : raw instanceof Uint8Array
        ? Buffer.from(raw).toString('utf8')
        : typeof raw === 'string'
          ? raw
          : '{}';
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  function mapKnowledgeEntity(params: {
    id: string;
    entityTypeRaw: string;
    name: string;
    propertiesRaw: unknown;
    createdAt: string;
    updatedAt: string;
  }): KnowledgeEntity {
    return {
      id: params.id,
      entity_type: parseEntityType(params.entityTypeRaw),
      name: params.name,
      properties: parseKnowledgeProperties(params.propertiesRaw),
      created_at: params.createdAt,
      updated_at: params.updatedAt,
    };
  }

  function mapKnowledgeMatchRow(
    row: RawKnowledgeGraphRow,
  ): KnowledgeGraphMatch {
    return {
      source: mapKnowledgeEntity({
        id: row.s_id,
        entityTypeRaw: row.s_type,
        name: row.s_name,
        propertiesRaw: row.s_properties,
        createdAt: row.s_created_at,
        updatedAt: row.s_updated_at,
      }),
      relation: {
        source: row.r_source,
        relation: parseRelationType(row.r_type),
        target: row.r_target,
        properties: parseKnowledgeProperties(row.r_properties),
        confidence: Math.max(0, Math.min(1, Number(row.r_confidence) || 0)),
        created_at: row.r_created_at,
      },
      target: mapKnowledgeEntity({
        id: row.t_id,
        entityTypeRaw: row.t_type,
        name: row.t_name,
        propertiesRaw: row.t_properties,
        createdAt: row.t_created_at,
        updatedAt: row.t_updated_at,
      }),
    };
  }

  function addKnowledgeEntity(params: {
    id?: string | null;
    name: string;
    entityType: KnowledgeEntityTypeValue | string;
    properties?: Record<string, unknown> | null;
  }): string {
    const name = params.name.trim();
    if (!name) throw new Error('Knowledge graph entity name is required');

    const entityId = params.id?.trim() || randomUUID();
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO entities (id, entity_type, name, properties, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         properties = excluded.properties,
         updated_at = excluded.updated_at`,
      )
      .run(
        entityId,
        serializeEntityType(params.entityType),
        name,
        serializeKnowledgeProperties(params.properties),
        now,
        now,
      );

    return entityId;
  }

  function addKnowledgeRelation(params: {
    source: string;
    relation: KnowledgeRelationTypeValue | string;
    target: string;
    properties?: Record<string, unknown> | null;
    confidence?: number;
  }): string {
    const source = params.source.trim();
    const target = params.target.trim();
    if (!source) throw new Error('Knowledge graph relation source is required');
    if (!target) throw new Error('Knowledge graph relation target is required');

    const id = randomUUID();
    const rawConfidence =
      typeof params.confidence === 'number' &&
      Number.isFinite(params.confidence)
        ? params.confidence
        : 1;
    const confidence = Math.max(0, Math.min(1, rawConfidence));
    database
      .prepare(
        `INSERT INTO relations
        (id, source_entity, relation_type, target_entity, properties, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        source,
        serializeRelationType(params.relation),
        target,
        serializeKnowledgeProperties(params.properties),
        confidence,
        new Date().toISOString(),
      );

    return id;
  }

  function queryKnowledgeGraph(
    pattern: KnowledgeGraphPattern = {},
  ): KnowledgeGraphMatch[] {
    const sql = [
      `SELECT
         s.id AS s_id,
         s.entity_type AS s_type,
         s.name AS s_name,
         s.properties AS s_properties,
         s.created_at AS s_created_at,
         s.updated_at AS s_updated_at,
         r.id AS r_id,
         r.source_entity AS r_source,
         r.relation_type AS r_type,
         r.target_entity AS r_target,
         r.properties AS r_properties,
         r.confidence AS r_confidence,
         r.created_at AS r_created_at,
         t.id AS t_id,
         t.entity_type AS t_type,
         t.name AS t_name,
         t.properties AS t_properties,
         t.created_at AS t_created_at,
         t.updated_at AS t_updated_at
       FROM relations r
       JOIN entities s ON r.source_entity = s.id
       JOIN entities t ON r.target_entity = t.id
       WHERE 1 = 1`,
    ];
    const args: unknown[] = [];

    const source = pattern.source?.trim();
    if (source) {
      sql.push('AND (s.id = ? OR s.name = ?)');
      args.push(source, source);
    }

    if (pattern.relation) {
      sql.push('AND r.relation_type = ?');
      args.push(serializeRelationType(pattern.relation));
    }

    const target = pattern.target?.trim();
    if (target) {
      sql.push('AND (t.id = ? OR t.name = ?)');
      args.push(target, target);
    }

    // OpenFang-compatible v1 query semantics: single-hop relation scan, max 100.
    sql.push('LIMIT 100');

    const rows = queryAll<RawKnowledgeGraphRow, unknown[]>(
      database,
      sql.join('\n'),
      ...args,
    );
    return rows.map(mapKnowledgeMatchRow);
  }

  return { addKnowledgeEntity, addKnowledgeRelation, queryKnowledgeGraph };
}

type KnowledgeGraphStore = ReturnType<typeof createKnowledgeGraphStore>;
const knowledgeGraphStores = new WeakMap<
  Database.Database,
  KnowledgeGraphStore
>();

function withKnowledgeGraphStore<T>(
  operation: (store: KnowledgeGraphStore) => T,
): T {
  return withMemoryDatabase((database) => {
    let store = knowledgeGraphStores.get(database);
    if (!store) {
      store = createKnowledgeGraphStore(database);
      knowledgeGraphStores.set(database, store);
    }
    return operation(store);
  });
}

export function addKnowledgeEntity(params: {
  id?: string | null;
  name: string;
  entityType: KnowledgeEntityTypeValue | string;
  properties?: Record<string, unknown> | null;
}): string {
  return withKnowledgeGraphStore((store) => store.addKnowledgeEntity(params));
}

export function addKnowledgeRelation(params: {
  source: string;
  relation: KnowledgeRelationTypeValue | string;
  target: string;
  properties?: Record<string, unknown> | null;
  confidence?: number;
}): string {
  return withKnowledgeGraphStore((store) => store.addKnowledgeRelation(params));
}

export function queryKnowledgeGraph(
  pattern: KnowledgeGraphPattern = {},
): KnowledgeGraphMatch[] {
  return withKnowledgeGraphStore((store) => store.queryKnowledgeGraph(pattern));
}
