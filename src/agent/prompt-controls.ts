import type { WorkspaceContextFileName } from '../workspace.js';

export type PromptMode = 'full' | 'minimal' | 'none';

export interface PromptAblation {
  omitWorkspaceFiles?: WorkspaceContextFileName[];
}
