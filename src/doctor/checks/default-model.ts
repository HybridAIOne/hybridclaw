/**
 * Doctor check: is the default model still a current model?
 *
 * A legacy default keeps working until its provider retires it, after which
 * every new session fails. The check warns early and, when the provider names
 * a successor, offers to switch to it. It reads status from the model catalog
 * and never guesses a successor the provider did not name.
 */
import {
  getRuntimeConfig,
  updateRuntimeConfig,
} from '../../config/runtime-config.js';
import {
  getModelLifecycle,
  refreshAvailableModelCatalogs,
} from '../../providers/model-catalog.js';
import type { DiagResult } from '../types.js';
import { makeResult } from '../utils.js';

export async function checkDefaultModel(): Promise<DiagResult[]> {
  await refreshAvailableModelCatalogs({ includeHybridAI: true });
  const model = getRuntimeConfig().hybridai.defaultModel.trim();
  if (!model) return [];
  const { status, replacement } = getModelLifecycle(model);
  if (status === 'current') {
    return [
      makeResult('providers', 'Default model', 'ok', `${model} is current`),
    ];
  }
  if (!replacement) {
    return [
      makeResult(
        'providers',
        'Default model',
        'warn',
        `${model} is a legacy model; pick a current one with \`/model list\` and \`/model default <name>\`.`,
      ),
    ];
  }
  return [
    makeResult(
      'providers',
      'Default model',
      'warn',
      `${model} is a legacy model; its provider names ${replacement} as the replacement.`,
      {
        summary: `Switch the default model to ${replacement}`,
        apply: async () => {
          updateRuntimeConfig((draft) => {
            draft.hybridai.defaultModel = replacement;
          });
        },
        rollback: async () => {
          updateRuntimeConfig((draft) => {
            draft.hybridai.defaultModel = model;
          });
        },
      },
    ),
  ];
}
