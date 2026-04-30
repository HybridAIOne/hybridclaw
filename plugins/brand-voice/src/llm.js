async function fetchJsonWithTimeout(url, init, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...init, signal });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `brand-voice: ${url} returned ${response.status}: ${bodyText.slice(0, 400)}`,
    );
  }
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    throw new Error(
      `brand-voice: failed to parse JSON from ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function extractAnthropicText(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const out = [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      out.push(block.text);
    }
  }
  return out.join('\n').trim();
}

function extractOpenAIText(payload) {
  const choice =
    Array.isArray(payload?.choices) && payload.choices.length > 0
      ? payload.choices[0]
      : null;
  const content = choice?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

async function callAnthropic(client, apiKey, systemPrompt, userPrompt) {
  const payload = await fetchJsonWithTimeout(
    `${client.baseUrl.replace(/\/+$/, '')}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: client.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      }),
    },
    client.timeoutMs,
  );
  return extractAnthropicText(payload);
}

async function callOpenAI(client, apiKey, systemPrompt, userPrompt) {
  const url = client.baseUrl
    ? `${client.baseUrl.replace(/\/+$/, '')}/chat/completions`
    : 'https://api.openai.com/v1/chat/completions';
  const payload = await fetchJsonWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: client.model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    },
    client.timeoutMs,
  );
  return extractOpenAIText(payload);
}

export async function callBrandVoiceModel({
  client,
  api,
  systemPrompt,
  userPrompt,
}) {
  if (client.provider === 'none') {
    throw new Error('brand-voice: model client provider is "none"');
  }
  const apiKey = api.getCredential(client.apiKeyEnv) || '';
  if (client.provider !== 'openai-compat' && !apiKey) {
    throw new Error(
      `brand-voice: missing API key in env ${client.apiKeyEnv} for provider "${client.provider}"`,
    );
  }
  const attempts = Math.max(1, (client.maxRetries ?? 0) + 1);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (client.provider === 'anthropic') {
        return await callAnthropic(client, apiKey, systemPrompt, userPrompt);
      }
      return await callOpenAI(client, apiKey, systemPrompt, userPrompt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('brand-voice: model call failed');
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
