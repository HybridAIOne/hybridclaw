export async function callBrandVoiceModel({
  client,
  api,
  systemPrompt,
  userPrompt,
  fallbackModel,
}) {
  if (client.provider === 'model' && !client.model) {
    throw new Error('brand-voice: selected model source requires a model id.');
  }
  if (!['default', 'auxiliary', 'model'].includes(client.provider)) {
    throw new Error(
      `brand-voice: unsupported model source "${client.provider}"`,
    );
  }
  const result = await api.callAuxiliaryModel({
    task: 'skills_hub',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    provider: client.provider === 'default' ? 'auto' : undefined,
    model:
      client.provider === 'default'
        ? fallbackModel
        : client.provider === 'model'
          ? client.model
          : undefined,
    fallbackModel,
    fallbackEnableRag: false,
    maxTokens: 1024,
    temperature: 0,
    timeoutMs: 8000,
  });
  return result.content;
}

export function tryParseClassifierVerdict(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const jsonMatch =
    /^\{[\s\S]*\}$/m.exec(trimmed) ||
    /\{[\s\S]*"verdict"[\s\S]*\}/.exec(trimmed);
  const candidate = jsonMatch ? jsonMatch[0] : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const verdict = String(parsed.verdict || '').toLowerCase();
  if (verdict !== 'on_brand' && verdict !== 'off_brand') return null;
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((entry) => typeof entry === 'string')
    : [];
  const severity = ['low', 'medium', 'high'].includes(
    String(parsed.severity || '').toLowerCase(),
  )
    ? String(parsed.severity).toLowerCase()
    : 'medium';
  return { verdict, reasons, severity };
}
