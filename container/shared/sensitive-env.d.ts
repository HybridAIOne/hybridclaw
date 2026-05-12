export interface SensitiveEnvRules {
  exact: ReadonlySet<string>;
  prefixes: readonly string[];
  suffixes: readonly string[];
}

export declare const SENSITIVE_ENV_RULES: SensitiveEnvRules;

export declare function isSensitiveEnvName(
  name: string,
  rules?: SensitiveEnvRules,
): boolean;

export declare function buildSanitizedEnv(
  sourceEnv: Record<string, string | undefined>,
): Record<string, string>;
