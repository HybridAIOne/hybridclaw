/**
 * Indirection that lets the trust ledger drop cached A2A identity resolutions
 * without importing `identity-resolver.ts`, which itself imports the trust
 * ledger. Keep it unless that import cycle goes away.
 */

type A2AIdentityResolverInvalidator = (canonicalId?: string) => void;

const invalidators = new Set<A2AIdentityResolverInvalidator>();

export function registerA2AIdentityResolverInvalidator(
  invalidator: A2AIdentityResolverInvalidator,
): () => void {
  invalidators.add(invalidator);
  return () => {
    invalidators.delete(invalidator);
  };
}

export function invalidateA2AIdentityResolvers(canonicalId?: string): void {
  for (const invalidator of invalidators) {
    invalidator(canonicalId);
  }
}
