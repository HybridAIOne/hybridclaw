export type StakesLevel = 'low' | 'medium' | 'high';
export type StakesApprovalTier = 'green' | 'yellow' | 'red';

export interface StakesSignal {
  name: string;
  level: StakesLevel;
  score: number;
  reason: string;
}

export interface StakesScore {
  level: StakesLevel;
  score: number;
  confidence: number;
  classifier: string;
  signals: StakesSignal[];
  reasons: string[];
}

export interface StakesClassificationInput {
  toolName: string;
  args: Record<string, unknown>;
  actionKey: string;
  intent: string;
  reason: string;
  target: string;
  approvalTier: StakesApprovalTier;
  pathHints: string[];
  hostHints: string[];
  writeIntent: boolean;
  pinned: boolean;
}

export interface StakesClassifier {
  classify(input: StakesClassificationInput): StakesScore | null | undefined;
}
