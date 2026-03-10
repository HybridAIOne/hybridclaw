import { CONFIGURED_MODELS } from '../config/config.js';
import {
  discoverAllLocalModels,
  getDiscoveredLocalModelNames,
} from './local-discovery.js';

function dedupeModelList(models: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const rawModel of models) {
    const model = String(rawModel || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    deduped.push(model);
  }
  return deduped;
}

export function getAvailableModelList(): string[] {
  return dedupeModelList([
    ...CONFIGURED_MODELS,
    ...getDiscoveredLocalModelNames(),
  ]);
}

export async function getAvailableModelChoices(
  limit = 25,
): Promise<Array<{ name: string; value: string }>> {
  try {
    await discoverAllLocalModels();
  } catch {
    // Best-effort enrichment only.
  }

  return getAvailableModelList()
    .slice(0, Math.max(0, limit))
    .map((model) => ({
      name: model,
      value: model,
    }));
}
