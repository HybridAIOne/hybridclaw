/**
 * `/model list` — the models a user picks from, current ones first — and the
 * note commands add when a user picks a legacy model anyway.
 *
 * Legacy models stay usable but are left out unless the user asks for
 * `all` or no current model is left to show; the session's own model is always
 * listed so the current choice never disappears. The TUI picker reads the same
 * `modelCatalog` entries.
 *
 * NOT the source of model status (`providers/model-status.ts`); this module
 * only decides what a listing shows.
 */
import {
  getModelLifecycle,
  isAvailableModelFree,
} from '../providers/model-catalog.js';
import {
  formatModelCountSuffix,
  formatModelForDisplay,
} from '../providers/model-names.js';
import { isRecommendedModel } from '../providers/recommended-models.js';
import { infoCommand } from './gateway-command-results.js';
import type {
  GatewayCommandResult,
  GatewayModelCatalogEntry,
} from './gateway-types.js';

export function buildModelListResult(params: {
  models: string[];
  currentModel: string;
  providerFilter: string | undefined;
  includeLegacy: boolean;
}): GatewayCommandResult {
  const { models, currentModel, providerFilter } = params;
  const lifecycles = models.map((model) => getModelLifecycle(model));
  const includeLegacy =
    params.includeLegacy ||
    lifecycles.every((lifecycle) => lifecycle.status === 'legacy');
  const modelCatalog: GatewayModelCatalogEntry[] = [];
  const legacyEntries: GatewayModelCatalogEntry[] = [];
  let hiddenLegacyCount = 0;
  for (const [index, model] of models.entries()) {
    const lifecycle = lifecycles[index];
    const isLegacy = lifecycle.status === 'legacy';
    if (isLegacy && !includeLegacy && model !== currentModel) {
      hiddenLegacyCount += 1;
      continue;
    }
    const label = formatModelForDisplay(model);
    const notes = [
      ...(isLegacy
        ? [
            lifecycle.replacement
              ? `legacy, use ${formatModelForDisplay(lifecycle.replacement)}`
              : 'legacy',
          ]
        : []),
      ...(model === currentModel ? ['current'] : []),
    ];
    (isLegacy ? legacyEntries : modelCatalog).push({
      value: model,
      label: notes.length > 0 ? `${label} (${notes.join(', ')})` : label,
      isFree: isAvailableModelFree(model),
      ...(isRecommendedModel(model) ? { recommended: true } : {}),
      ...(isLegacy ? { legacy: true } : {}),
    });
  }
  modelCatalog.push(...legacyEntries);

  const title = providerFilter
    ? `Available Models (${providerFilter})`
    : 'Available Models';
  if (modelCatalog.length === 0 && hiddenLegacyCount === 0) {
    return infoCommand(
      'Available Models',
      providerFilter
        ? `No models available for provider \`${providerFilter}\`.`
        : 'No models available.',
    );
  }
  const showAll = providerFilter
    ? `model list ${providerFilter} all`
    : 'model list all';
  const footer =
    hiddenLegacyCount > 0
      ? `${formatModelCountSuffix(modelCatalog.length)} · ${hiddenLegacyCount} legacy hidden (\`${showAll}\`)`
      : formatModelCountSuffix(modelCatalog.length);
  const list = modelCatalog.map((entry) => entry.label).join('\n');
  return infoCommand(title, list ? `${list}\n\n${footer}` : footer, undefined, {
    modelCatalog,
  });
}

/** One line for a command reply when `model` is legacy; none otherwise. */
export function legacyModelNote(model: string): string[] {
  const { status, replacement } = getModelLifecycle(model);
  if (status !== 'legacy') return [];
  const name = `\`${formatModelForDisplay(model)}\``;
  return [
    replacement
      ? `${name} is a legacy model; \`${formatModelForDisplay(replacement)}\` replaces it.`
      : `${name} is a legacy model; \`model list\` shows current ones.`,
  ];
}
