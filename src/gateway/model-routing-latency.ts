const EWMA_WEIGHT = 0.25;
const MAX_TRACKED_MODELS = 500;

const latencyByModel = new Map<string, number>();

export function recordModelRoutingLatency(
  model: string,
  durationMs: number,
): void {
  const normalizedModel = model.trim();
  if (!normalizedModel || !Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  const previous = latencyByModel.get(normalizedModel);
  if (
    !latencyByModel.has(normalizedModel) &&
    latencyByModel.size >= MAX_TRACKED_MODELS
  ) {
    const oldest = latencyByModel.keys().next().value;
    if (oldest) latencyByModel.delete(oldest);
  }
  latencyByModel.delete(normalizedModel);
  latencyByModel.set(
    normalizedModel,
    previous === undefined
      ? durationMs
      : previous * (1 - EWMA_WEIGHT) + durationMs * EWMA_WEIGHT,
  );
}

export function getModelRoutingLatencies(
  models: readonly string[],
): Record<string, number | undefined> {
  return Object.fromEntries(
    models.map((model) => [model, latencyByModel.get(model)]),
  );
}

export function clearModelRoutingLatenciesForTests(): void {
  latencyByModel.clear();
}
