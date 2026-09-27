/**
 * Memory embedding providers — the built-in `hashed` id plus the registry that
 * maps every other `memory.embedding.provider` id (for example `transformers`
 * from the transformers-embeddings plugin) to the plugin that supplies it. An
 * unregistered id fails; it never silently falls back to `hashed`, because
 * vectors from different providers are not comparable.
 *
 * NOT the memory-layer registry: memory layers inject prompt context, while an
 * embedding provider only turns text into vectors for built-in memory.
 * Providers are synchronous because semantic memory embeds inline.
 */

/** `hashed`, or the id a plugin registered through `registerEmbeddingProvider`. */
export type MemoryEmbeddingProviderKind = string;

export const DEFAULT_MEMORY_EMBEDDING_PROVIDER: MemoryEmbeddingProviderKind =
  'hashed';

export function normalizeMemoryEmbeddingProviderKind(
  value: unknown,
  fallback: MemoryEmbeddingProviderKind,
): MemoryEmbeddingProviderKind {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'hash') return 'hashed';
  if (normalized === 'transformers.js') return 'transformers';
  return normalized || fallback;
}

export interface EmbeddingProvider {
  embed?(text: string): number[] | null;
  embedQuery?(text: string): number[] | null;
  embedDocument?(text: string): number[] | null;
  warmup?(): void;
  dispose?(): void;
}

export interface EmbeddingProviderRegistration {
  id: string;
  /** Model identifier shown in eval reports. */
  model?: string;
  create(): EmbeddingProvider;
}

export interface RegisteredEmbeddingProvider {
  pluginId: string;
  registration: EmbeddingProviderRegistration;
}

let providers = new Map<string, RegisteredEmbeddingProvider>();

export function registerEmbeddingProvider(
  pluginId: string,
  registration: EmbeddingProviderRegistration,
): void {
  const id = String(registration.id || '').trim();
  if (!id) throw new Error('Embedding provider is missing `id`.');
  if (id === 'hashed' || providers.has(id)) {
    throw new Error(`Embedding provider "${id}" is already registered.`);
  }
  providers.set(id, { pluginId, registration });
}

export function getEmbeddingProviderRegistration(
  id: string,
): EmbeddingProviderRegistration | undefined {
  return providers.get(id)?.registration;
}

export function snapshotEmbeddingProviders(): Map<
  string,
  RegisteredEmbeddingProvider
> {
  return new Map(providers);
}

export function restoreEmbeddingProviders(
  snapshot: Map<string, RegisteredEmbeddingProvider>,
): void {
  providers = new Map(snapshot);
}

export function clearEmbeddingProviders(): void {
  providers.clear();
}
