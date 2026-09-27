export declare function hasGlobWildcard(pattern: string): boolean;

export declare function globToRegExp(
  pattern: string,
  kind: 'path' | 'host' | 'text',
): RegExp;
