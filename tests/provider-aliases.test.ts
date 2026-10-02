import fs from 'node:fs';
import path from 'node:path';

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

  test('google is not a model-provider alias (it names the Workspace auth target)', () => {
    expect(normalizeModelCatalogProviderFilter('google')).toBeNull();
  });

  test('getProviderAliasesFor returns every alias that maps to the given id', () => {
    expect(getProviderAliasesFor('gemini')).toEqual(['google-gemini']);
    expect(getProviderAliasesFor('zai').sort()).toEqual(
      ['z-ai', 'glm', 'zhipu'].sort(),
    );
    expect(getProviderAliasesFor('mistral')).toEqual([]);
  });

  test('the model-selection docs list exactly PROVIDER_ALIASES', () => {
    const doc = fs.readFileSync(
      path.join(process.cwd(), 'docs/content/reference/model-selection.md'),
      'utf-8',
    );
    const section = doc.split('\n## Provider Names\n')[1]?.split('\n## ')[0];
    const documented: Record<string, string> = {};
    for (const [, names, canonical] of (section ?? '').matchAll(
      /^- (.+) → `([^`]+)`$/gm,
    )) {
      for (const [, alias] of names.matchAll(/`([^`]+)`/g)) {
        documented[alias] = canonical;
      }
    }
    expect(documented).toEqual(PROVIDER_ALIASES);
  });
});
