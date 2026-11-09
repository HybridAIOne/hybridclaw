/**
 * Model status — whether a model the catalog lists is `current` or `legacy`.
 *
 * A legacy model still works: pickers fold it away and automatic choices
 * prefer a current one. A retired model is one its provider no longer serves;
 * discovery drops it, so the catalog never lists it and needs no status for it.
 *
 * NOT a deny-list. Nothing here hides a model its provider still serves, and
 * the catalog (`model-catalog.ts`) decides which source answers for a model.
 */
import { providerModelPrefix } from './provider-ids.js';

export type ModelStatus = 'current' | 'legacy';

export interface ModelLifecycle {
  status: ModelStatus;
  /** Successor the provider names for a legacy model, as listed. */
  replacement: string | null;
}

export const CURRENT_MODEL: ModelLifecycle = {
  status: 'current',
  replacement: null,
};

/**
 * Reads the optional fields a `/models` entry may add to the OpenAI shape:
 * Mistral's `archived`, `deprecation` (the retirement date) and
 * `deprecation_replacement_model`. HybridAI publishes the same fields so its
 * endpoint stays OpenAI-compatible, but sends only the replacement when no
 * retirement date is known; either field marks the model legacy.
 */
export function readListedModelStatus(
  entry: Record<string, unknown>,
  nowMs = Date.now(),
): ModelLifecycle | 'retired' {
  if (entry.archived === true) return 'retired';
  const retiresAtMs =
    typeof entry.deprecation === 'string'
      ? Date.parse(entry.deprecation)
      : Number.NaN;
  if (retiresAtMs <= nowMs) return 'retired';
  const replacement =
    typeof entry.deprecation_replacement_model === 'string'
      ? entry.deprecation_replacement_model.trim()
      : '';
  if (!entry.deprecation && !replacement) return CURRENT_MODEL;
  return { status: 'legacy', replacement: replacement || null };
}

// Maintainer call, 2026-11-08: Anthropic and Codex publish no deprecation
// field, so their superseded models are listed here. Entries follow the t3code
// model manifest of 2026-11-05 plus older ids Anthropic and Codex discovery
// still return. A model missing here shows as current; dated snapshots match
// their undated id.
const CURATED_LEGACY_MODEL_IDS: ReadonlyArray<
  readonly [prefix: string, ids: ReadonlySet<string>]
> = [
  [
    providerModelPrefix('anthropic'),
    new Set([
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-opus-4-0',
      'claude-opus-4',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4-0',
      'claude-sonnet-4',
      'claude-haiku-4-5',
      'claude-3-7-sonnet',
      'claude-3-5-sonnet',
      'claude-3-5-haiku',
      'claude-3-opus',
      'claude-3-haiku',
    ]),
  ],
  [
    providerModelPrefix('openai-codex'),
    new Set([
      'gpt-6-sol',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5',
      'gpt-5-codex',
    ]),
  ],
];

export function isCuratedLegacyModel(model: string): boolean {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  for (const [prefix, ids] of CURATED_LEGACY_MODEL_IDS) {
    if (!normalized.startsWith(prefix)) continue;
    return ids.has(normalized.slice(prefix.length).replace(/-\d{8}$/, ''));
  }
  return false;
}
