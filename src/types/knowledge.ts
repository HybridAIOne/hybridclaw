export enum KnowledgeEntityType {
  Person = 'person',
  Organization = 'organization',
  Project = 'project',
  Concept = 'concept',
  Event = 'event',
  Location = 'location',
  Document = 'document',
  Tool = 'tool',
}

export interface KnowledgeEntityCustomType {
  custom: string;
}

export type KnowledgeEntityTypeValue =
  | KnowledgeEntityType
  | KnowledgeEntityCustomType;

export enum KnowledgeRelationType {
  WorksAt = 'works_at',
  KnowsAbout = 'knows_about',
  RelatedTo = 'related_to',
  DependsOn = 'depends_on',
  OwnedBy = 'owned_by',
  CreatedBy = 'created_by',
  LocatedIn = 'located_in',
  PartOf = 'part_of',
  Uses = 'uses',
  Produces = 'produces',
}

export interface KnowledgeRelationCustomType {
  custom: string;
}

export type KnowledgeRelationTypeValue =
  | KnowledgeRelationType
  | KnowledgeRelationCustomType;

export interface KnowledgeEntity {
  id: string;
  entity_type: KnowledgeEntityTypeValue;
  name: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeRelation {
  source: string;
  relation: KnowledgeRelationTypeValue;
  target: string;
  properties: Record<string, unknown>;
  confidence: number;
  created_at: string;
}

export interface KnowledgeGraphPattern {
  source?: string;
  relation?: KnowledgeRelationTypeValue;
  target?: string;
  max_depth?: number;
}

export interface KnowledgeGraphMatch {
  source: KnowledgeEntity;
  relation: KnowledgeRelation;
  target: KnowledgeEntity;
}
