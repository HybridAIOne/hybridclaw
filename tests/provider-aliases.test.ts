import { describe, expect, test } from 'vitest';

import { normalizeModelCatalogProviderFilter } from '../src/providers/model-catalog.js';
import {
  getProviderAliasesFor,
  PROVIDER_ALIASES,
} from '../src/providers/provider-aliases.js';

describe('provider aliases', () => {
  test('normalizeModelCatalogProviderFilter resolves every alias to its canonical id', () => {
    for (const [alias, canonical] of Object.entries(PROVIDER_ALIASES)) {
      expect(normalizeModelCatalogProviderFilter(alias)).toBe(canonical);
      expect(normalizeModelCatalogProviderFilter(alias.toUpperCase())).toBe(
        canonical,
      );
    }
  });

  test('normalizeModelCatalogProviderFilter passes canonical ids through unchanged', () => {
    expect(normalizeModelCatalogProviderFilter('gemini')).toBe('gemini');
    expect(normalizeModelCatalogProviderFilter('kilo')).toBe('kilo');
    expect(normalizeModelCatalogProviderFilter('local')).toBe('local');
    expect(normalizeModelCatalogProviderFilter('openai-codex')).toBe(
      'openai-codex',
    );
  });

  test('normalizeModelCatalogProviderFilter returns null for unknown input', () => {
    expect(normalizeModelCatalogProviderFilter('')).toBeNull();
    expect(normalizeModelCatalogProviderFilter(undefined)).toBeNull();
    expect(normalizeModelCatalogProviderFilter('nonsense-provider')).toBeNull();
  });

  test('getProviderAliasesFor returns every alias that maps to the given id', () => {
    expect(getProviderAliasesFor('gemini').sort()).toEqual(
      ['google', 'google-gemini'].sort(),
    );
    expect(getProviderAliasesFor('zai').sort()).toEqual(
      ['z-ai', 'glm', 'zhipu'].sort(),
    );
    expect(getProviderAliasesFor('mistral')).toEqual([]);
  });
});
