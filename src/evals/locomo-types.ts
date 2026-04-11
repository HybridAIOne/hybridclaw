import type { MemoryEmbeddingProviderKind } from '../memory/embeddings.js';
import type {
  MemoryQueryMode,
  MemoryRecallBackend,
  MemoryRecallRerank,
  MemoryRecallTokenizer,
} from '../memory/semantic-recall.js';

export type LocomoAgentMode = 'conversation-fresh' | 'current-agent';
export type LocomoRetrievalPolicy = 'prompt-capped' | 'budget-only';
export type LocomoRetrievalSweep =
  | 'all'
  | 'backend'
  | 'rerank'
  | 'tokenizer'
  | 'embedding';
export type LocomoRetrievalQueryMode = MemoryQueryMode;
export type LocomoRetrievalBackend = MemoryRecallBackend;
export type LocomoRetrievalRerank = MemoryRecallRerank;
export type LocomoRetrievalTokenizer = MemoryRecallTokenizer;
export type LocomoRetrievalEmbeddingProvider = MemoryEmbeddingProviderKind;
export type LocomoProgressPhase =
  | 'warming-embedding'
  | 'ingesting'
  | 'evaluating';
export const LOCOMO_DATASET_FILENAME = 'locomo10.json';
export const LOCOMO_SETUP_MARKER = '.hybridclaw-setup-ok';

export interface LocomoCategoryAggregate {
  meanScore: number;
  questionCount: number;
  contextF1: number | null;
}

export interface LocomoTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responsesWithUsage: number;
}

export interface LocomoRetrievalVariantSummary {
  id: string;
  label: string;
  retrievalPolicy: LocomoRetrievalPolicy;
  retrievalQueryMode: LocomoRetrievalQueryMode;
  retrievalBackend: LocomoRetrievalBackend;
  retrievalRerank: LocomoRetrievalRerank;
  retrievalTokenizer: LocomoRetrievalTokenizer;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider;
  retrievalEmbeddingModel: string | null;
  sampleCount: number;
  questionCount: number;
  overallScore: number;
  contextF1: number | null;
  categories: Record<string, LocomoCategoryAggregate>;
}

export interface LocomoRetrievalVariantProgress
  extends LocomoRetrievalVariantSummary {
  currentPhase: LocomoProgressPhase | null;
  completedSampleCount: number;
  completedQuestionCount: number;
  currentSampleId: string | null;
  currentSampleEmbeddedTurnCount: number | null;
  currentSampleTurnCount: number | null;
  currentSampleQuestionCount: number | null;
  currentSampleQuestionTotal: number | null;
}
