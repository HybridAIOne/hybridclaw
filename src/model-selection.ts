export function normalizeModelCandidates(models: string[]): string[] {
  const deduped = new Set<string>();
  for (const model of models) {
    const candidate = String(model || '').trim();
    if (!candidate) continue;
    deduped.add(candidate);
  }
  return Array.from(deduped);
}

export function parseModelNamesFromListText(text: string): string[] {
  return normalizeModelCandidates(
    String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/\s+\((current|default)\)$/i, '')),
  );
}

export interface ParsedModelInfoSummary {
  current: string | null;
  defaultModel: string | null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeModelInfoValue(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (/^\((none|inherits[^)]*)\)$/i.test(trimmed)) return null;
  return trimmed;
}

function findLabeledLineValue(text: string, label: string): string | null {
  const match = text.match(
    new RegExp(`^${escapeRegex(label)}:\\s*([^\\n\\r]+)$`, 'im'),
  );
  return normalizeModelInfoValue(match?.[1] || '');
}

export function parseModelInfoSummaryFromText(
  text: string,
): ParsedModelInfoSummary | null {
  const source = String(text || '').trim();
  if (!source) return null;

  const legacyCurrent = findLabeledLineValue(source, 'Current model');
  const legacyDefault = findLabeledLineValue(source, 'Default model');
  if (legacyCurrent || legacyDefault) {
    return {
      current: legacyCurrent || legacyDefault,
      defaultModel: legacyDefault || legacyCurrent,
    };
  }

  const effectiveModel = findLabeledLineValue(source, 'Effective model');
  const globalModel =
    findLabeledLineValue(source, 'Global model') ||
    findLabeledLineValue(source, 'Global default');
  const agentModel = findLabeledLineValue(source, 'Agent model');
  const sessionModel =
    findLabeledLineValue(source, 'Session model') ||
    findLabeledLineValue(source, 'Session override');

  const current =
    effectiveModel || sessionModel || agentModel || globalModel || null;
  const defaultModel =
    globalModel || effectiveModel || sessionModel || agentModel || null;

  if (!current && !defaultModel) return null;
  return { current, defaultModel };
}
