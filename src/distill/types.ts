export type DistillStageName =
  | 'ingest'
  | 'analyse'
  | 'build'
  | 'merge'
  | 'correct';

export const DISTILL_STAGE_ORDER: readonly DistillStageName[] = [
  'ingest',
  'analyse',
  'build',
  'merge',
  'correct',
] as const;

export type DistillStageStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'awaiting-extraction';

export interface DistillStageState {
  status: DistillStageStatus;
  startedAt?: string;
  completedAt?: string;
  detail?: string;
}

export interface SubjectProfile {
  version: 1;
  /** Path-safe slug used as the coworker agent id and directory name. */
  alias: string;
  displayName: string;
  /**
   * Real named humans require a recorded consent artefact before any run.
   * Defaults to true: deny-by-default per Principle VII.
   */
  realPerson: boolean;
  role?: string;
  relationship?: string;
  personalityTags: string[];
  /** Names, handles, and emails used to attribute corpus authorship. */
  matchAliases: string[];
  createdAt: string;
}

export interface ConsentArtefact {
  version: 1;
  subject: string;
  subjectName: string;
  grantedBy: string;
  method: string;
  scope: string;
  statement: string;
  note?: string;
  recordedAt: string;
  sha256: string;
  revokedAt?: string;
}

export type CorpusSourceKind =
  | 'slack-export'
  | 'email-mbox'
  | 'transcript'
  | 'chat-jsonl'
  | 'markdown'
  | 'text'
  | 'interview'
  | 'correction';

export interface CorpusDocument {
  /** Stable provenance id derived from content: doc_<sha256-prefix>. */
  id: string;
  subject: string;
  source: CorpusSourceKind;
  /** Original file path, channel, or surface the document came from. */
  origin: string;
  author: string;
  authoredBySubject: boolean;
  title?: string;
  channel?: string;
  timestamp?: string;
  content: string;
  wordCount: number;
  /** Quality weight in [0, 1]; long-form authored text ranks highest. */
  weight: number;
  /** Held out from analysis packets; reserved for fidelity eval. */
  holdout?: boolean;
  maskedThirdParties: number;
  ingestedAt: string;
  runId?: string;
}

export type PersonaDimension =
  | 'identity'
  | 'expression'
  | 'decision-making'
  | 'interpersonal'
  | 'experience'
  | 'correction';

export const PERSONA_DIMENSIONS: readonly PersonaDimension[] = [
  'identity',
  'expression',
  'decision-making',
  'interpersonal',
  'experience',
  'correction',
] as const;

export interface ExtractionClaim {
  dimension: PersonaDimension;
  claim: string;
  /** Corpus document ids supporting the claim. Required and verified. */
  evidence: string[];
  confidence: number;
  /**
   * Standing claim id this claim contradicts or replaces. Declared conflicts
   * are surfaced as review items for the operator, never silently merged.
   */
  conflictsWith?: string;
}

export interface ExtractionWorkflow {
  title: string;
  steps: string[];
  evidence: string[];
}

export interface ExtractionKnowHow {
  topic: string;
  notes: string;
  evidence: string[];
}

export interface ExtractionWorkedExample {
  title: string;
  situation: string;
  approach: string;
  outcome?: string;
  evidence: string[];
}

export interface ExtractionWorkModule {
  skillName: string;
  description: string;
  scope: string[];
  workflows: ExtractionWorkflow[];
  outputPreferences: ExtractionClaim[];
  knowHow: ExtractionKnowHow[];
  workedExamples: ExtractionWorkedExample[];
}

/**
 * The single contract through which model judgment enters the pipeline.
 * Filled by the analysing agent, validated by the engine, rendered
 * deterministically into the identity files and work-module skill.
 */
export interface DistillExtraction {
  version: 1;
  subject: string;
  runId: string;
  identity: {
    name: string;
    creature: string;
    vibe: string;
    emoji: string;
  };
  claims: ExtractionClaim[];
  workModule: ExtractionWorkModule;
  userNotes: string[];
  openQuestions: string[];
}

export interface PersonaClaim extends ExtractionClaim {
  id: string;
  status: 'standing' | 'superseded' | 'under-review';
  firstSeenRunId: string;
  updatedAt: string;
}

export interface DistillReviewItem {
  id: string;
  subject: string;
  openedAt: string;
  runId: string;
  dimension: PersonaDimension;
  standingClaimId: string;
  standingClaim: string;
  incomingClaim: string;
  incomingEvidence: string[];
  status: 'open' | 'resolved';
  resolution?: 'keep-standing' | 'accept-incoming' | 'keep-both';
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface DistillState {
  version: 1;
  subject: string;
  analysedDocIds: string[];
  claims: PersonaClaim[];
  /** Latest identity block and user notes, kept so review resolutions can re-render persona files without a fresh extraction. */
  identity?: DistillExtraction['identity'];
  userNotes?: string[];
  skillName?: string;
  mergeHistory: {
    runId: string;
    mergedAt: string;
    claimsAdded: number;
    claimsSuperseded: number;
    reviewsOpened: number;
  }[];
}

export interface DistillRunSource {
  path: string;
  kind: CorpusSourceKind | 'auto';
}

export interface DistillRunRecord {
  version: 1;
  runId: string;
  subject: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  stages: Record<DistillStageName, DistillStageState>;
  sources: DistillRunSource[];
  stats: {
    documentsAdded: number;
    documentsTotal: number;
    deltaDocuments: number;
    claimsAdded: number;
    claimsFlagged: number;
    reviewsOpened: number;
  };
  notes: string[];
}

export interface CorrectionRecord {
  id: string;
  subject: string;
  text: string;
  scope: 'persona' | 'work' | 'both';
  recordedBy: string;
  recordedAt: string;
  /** Corpus document carrying this correction into the next analyse stage. */
  docId: string;
  promotedRunId?: string;
}

export class DistillBlockedError extends Error {
  readonly remediation: string;

  constructor(message: string, remediation: string) {
    super(message);
    this.name = 'DistillBlockedError';
    this.remediation = remediation;
  }
}
