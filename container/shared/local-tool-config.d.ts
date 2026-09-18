export declare const DEFAULT_LOCAL_STARTER_TOOLS: readonly string[];
export declare function normalizeLocalStarterTools(
  value: unknown,
  field: string,
): string[] | undefined;

export type LocalContextMode = 'full' | 'starred';
export declare function normalizeLocalContextMode(
  value: unknown,
  field: string,
): LocalContextMode | undefined;

export declare function normalizeLocalStarredNames(
  value: unknown,
  field: string,
): string[] | undefined;
