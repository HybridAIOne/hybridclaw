export type MSTeamsLifecyclePhase =
  | 'queued'
  | 'thinking'
  | 'toolUse'
  | 'streaming'
  | 'done'
  | 'error';

export function createMSTeamsReactionController() {
  let phase: MSTeamsLifecyclePhase = 'queued';
  return {
    setPhase(next: MSTeamsLifecyclePhase): void {
      phase = next;
    },
    getPhase(): MSTeamsLifecyclePhase {
      return phase;
    },
    async clear(): Promise<void> {},
  };
}
