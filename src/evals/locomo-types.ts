export type LocomoAgentMode = 'conversation-fresh' | 'current-agent';
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
