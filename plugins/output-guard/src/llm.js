const OUTPUT_GUARD_MODEL_TIMEOUT_MS = 300_000;
const MODEL_PROVIDER_PREFIXES = [
  'openai-codex',
  'anthropic',
  'openrouter',
  'mistral',
  'huggingface',
  'gemini',
  'deepseek',
  'xai',
  'zai',
  'kimi',
  'minimax',
  'dashscope',
  'xiaomi',
  'kilo',
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
];

function inferModelProvider(model) {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  return MODEL_PROVIDER_PREFIXES.find((provider) =>
    normalized.startsWith(`${provider}/`),
  );
}

export async function callOutputGuardModel({
  client,
  api,
  systemPrompt,
  userPrompt,
  fallbackModel,
}) {
  if (client.provider === 'model' && !client.model) {
    throw new Error('output-guard: selected model source requires a model id.');
  }
  if (!['default', 'auxiliary', 'model'].includes(client.provider)) {
    throw new Error(
      `output-guard: unsupported model source "${client.provider}"`,
    );
  }
  const model =
    client.provider === 'default'
      ? fallbackModel
      : client.provider === 'model'
        ? client.model
        : undefined;
  const provider =
    client.provider === 'auxiliary'
      ? undefined
      : (inferModelProvider(model) ??
        (client.provider === 'default' ? 'auto' : undefined));
  const result = await api.callAuxiliaryModel({
    task: 'skills_hub',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    provider,
    model,
    fallbackModel,
    fallbackEnableRag: false,
    maxTokens: 1024,
    temperature: 0,
    timeoutMs: OUTPUT_GUARD_MODEL_TIMEOUT_MS,
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
  if (verdict !== 'compliant' && verdict !== 'non_compliant') return null;
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
