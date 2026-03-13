const API_KEY_REQUIRED_PROVIDERS = new Set([
  'hybridai',
  'openai-codex',
  'openrouter',
]);

function buildMissingContextError(params) {
  const source = params.missingContextSource
    ? `${params.missingContextSource} `
    : '';
  return `${params.toolName} is not configured: missing ${source}${params.field} context.`;
}

export function getProviderContextError(params) {
  const provider = String(params.provider || 'hybridai').trim() || 'hybridai';
  if (!String(params.baseUrl || '').trim()) {
    return buildMissingContextError({
      toolName: params.toolName,
      field: 'base URL',
      missingContextSource: params.missingContextSource,
    });
  }
  if (!String(params.model || '').trim()) {
    return buildMissingContextError({
      toolName: params.toolName,
      field: 'model',
      missingContextSource: params.missingContextSource,
    });
  }
  if (
    API_KEY_REQUIRED_PROVIDERS.has(provider) &&
    !String(params.apiKey || '').trim()
  ) {
    return buildMissingContextError({
      toolName: params.toolName,
      field: 'API key',
      missingContextSource: params.missingContextSource,
    });
  }
  if (provider === 'hybridai' && !String(params.chatbotId || '').trim()) {
    return buildMissingContextError({
      toolName: params.toolName,
      field: 'chatbot_id',
      missingContextSource: params.missingContextSource,
    });
  }
  return null;
}
