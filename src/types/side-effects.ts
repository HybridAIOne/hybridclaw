export type ScheduleSideEffect =
  | {
      action: 'add';
      cronExpr?: string;
      runAt?: string;
      everyMs?: number;
      prompt: string;
    }
  | { action: 'remove'; taskId: number };

export interface DelegationTaskSpec {
  prompt: string;
  label?: string;
  model?: string;
}

export interface DelegationSideEffect {
  action: 'delegate';
  mode?: 'single' | 'parallel' | 'chain';
  prompt?: string;
  label?: string;
  model?: string;
  tasks?: DelegationTaskSpec[];
  chain?: DelegationTaskSpec[];
}
