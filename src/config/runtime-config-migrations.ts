/**
 * One-shot runtime-config migrations that move released keys to a new home.
 *
 * Each migration is gated on the source schema version, so it runs once: the
 * normalized config is written back at the current version without the old
 * keys. NOT the normalizer — defaults and validation stay in runtime-config.ts.
 */

import { isRecord } from '../utils/type-guards.js';

type RawRecord = Record<string, unknown>;

// compat: remove after v0.33 — memory.embedding.{model,revision,dtype} moved
// to the transformers-embeddings plugin config in schema v39.
const EMBEDDING_PLUGIN_ID = 'transformers-embeddings';
const EMBEDDING_PLUGIN_CONFIG_VERSION = 39;
const LEGACY_EMBEDDING_DEFAULTS: Record<string, string> = {
  model: 'onnx-community/embeddinggemma-300m-ONNX',
  revision: '75a84c732f1884df76bec365346230e32f582c82',
  dtype: 'q8',
};

/**
 * Returns `rawPlugins` with non-default legacy embedding settings copied into
 * the transformers-embeddings plugin entry. Values an operator already set on
 * the plugin entry win. Defaults are skipped: the normalizer wrote them into
 * every config, and the plugin schema carries the same defaults.
 */
export function migrateMemoryEmbeddingToPlugin(
  rawMemory: RawRecord,
  rawPlugins: RawRecord,
  sourceVersion: number | null,
): RawRecord {
  if (
    sourceVersion === null ||
    sourceVersion >= EMBEDDING_PLUGIN_CONFIG_VERSION
  )
    return rawPlugins;
  const legacy = isRecord(rawMemory.embedding) ? rawMemory.embedding : {};
  const moved: RawRecord = {};
  for (const [key, legacyDefault] of Object.entries(
    LEGACY_EMBEDDING_DEFAULTS,
  )) {
    const value = typeof legacy[key] === 'string' ? legacy[key].trim() : '';
    if (value && value !== legacyDefault) moved[key] = value;
  }
  if (Object.keys(moved).length === 0) return rawPlugins;

  const list = Array.isArray(rawPlugins.list) ? [...rawPlugins.list] : [];
  const index = list.findIndex(
    (entry) => isRecord(entry) && entry.id === EMBEDDING_PLUGIN_ID,
  );
  const existing = index >= 0 && isRecord(list[index]) ? list[index] : null;
  const entry = {
    id: EMBEDDING_PLUGIN_ID,
    enabled: true,
    ...existing,
    config: {
      ...moved,
      ...(existing && isRecord(existing.config) ? existing.config : {}),
    },
  };
  if (index >= 0) list[index] = entry;
  else list.push(entry);
  return { ...rawPlugins, list };
}
