/**
 * Privacy previews sample the current catalog without changing execution tiers.
 * Operator tier order is the preference signal, not an invented benchmark score;
 * model-maker diversity takes precedence over filling the preview from one vendor.
 */
import type { ChatModel } from '../api/types';

// The chat catalog has no task-kind field; recognize embedding/reranker names
// and families without excluding generative models from the same maker.
export function isRoutingLanguageModel(model: ChatModel): boolean {
  return !/(?:^|[/_. -])(?:embeddings?|embed|rerank(?:er)?|bge|e5)(?:$|[/_. -])/i.test(
    `${model.id} ${model.family ?? ''}`,
  );
}

function identity(id: string) {
  return id.toLowerCase().split('/').at(-1)!.replace(/:.*$/, '');
}
function maker(model: ChatModel) {
  const id = model.id.toLowerCase();
  if (/claude|anthropic/.test(id)) return 'anthropic';
  if (/gpt-|openai|\/o[134](?:-|$)/.test(id)) return 'openai';
  if (/mistral|ministral|codestral|devstral|mixtral/.test(id)) return 'mistral';
  if (/gemma|gemini|google/.test(id)) return 'google';
  if (/qwen/.test(id)) return 'qwen';
  if (/grok|xai/.test(id)) return 'xai';
  if (/llama|meta-llama/.test(id)) return 'meta';
  return model.id.split('/').slice(-2, -1)[0] ?? model.provider ?? model.id;
}
export function privacyModelPreview(
  models: ChatModel[],
  zone: NonNullable<ChatModel['zone']>,
  preferred: string[],
) {
  const preferredModels = preferred.map(identity);
  const rank = (id: string) => {
    const index = preferredModels.indexOf(identity(id));
    return index < 0 ? Infinity : index;
  };
  // Operator request (2026-09-22): old Haiku and duplicate batch/alias routes
  // should not occupy preview slots. Full catalog selection stays unchanged.
  const candidates = models
    .filter(
      (model) =>
        isRoutingLanguageModel(model) &&
        // Operator request (2026-09-22): preview general-purpose models only,
        // with direct Codex/Anthropic routes for World examples.
        !/(?:^|[/_. -])(?:code|coder|coding|image|vision|audio|tts|whisper|embedding)(?:$|[/_. -])/i.test(
          `${identity(model.id)} ${model.family ?? ''}`,
        ) &&
        (zone !== 'cloud' ||
          /^(?:codex|openai-codex|anthropic)\//i.test(model.id)) &&
        (model.zone ?? 'cloud') === zone &&
        !(model.backend && model.discovered === false) &&
        !/claude-3(?:[.-]|$)|:batch$|\/~/.test(model.id.toLowerCase()),
    )
    .sort(
      (a, b) =>
        rank(a.id) - rank(b.id) ||
        b.id.localeCompare(a.id, undefined, { numeric: true }),
    );
  const unique = candidates.filter(
    (model, index) =>
      candidates.findIndex(
        (other) => identity(other.id) === identity(model.id),
      ) === index,
  );
  const selected: ChatModel[] = [];
  for (const model of unique) {
    if (!selected.some((other) => maker(other) === maker(model)))
      selected.push(model);
    if (selected.length === 3) return selected;
  }
  for (const model of unique) {
    if (!selected.includes(model)) selected.push(model);
    if (selected.length === 3) break;
  }
  return selected;
}
