function normalizeBaseUrl(value) {
  const trimmed = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  return trimmed || 'https://hybridai.one';
}

function parseErrorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload || fallback;
  if (typeof payload !== 'object') return fallback;

  const record = payload;
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message.trim();
  }
  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error.trim();
  }
  if (record.error && typeof record.error === 'object') {
    const nested = record.error;
    if (typeof nested.message === 'string' && nested.message.trim()) {
      return nested.message.trim();
    }
  }
  return fallback;
}

async function readResponsePayload(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeHandleEntry(input) {
  if (!input || typeof input !== 'object') return null;

  const handle = String(input.handle || '')
    .trim()
    .toLowerCase();
  if (!handle) return null;

  return {
    id: Number.isFinite(Number(input.id)) ? Number(input.id) : null,
    handle,
    label: String(input.label || '').trim() || null,
    instanceId: Number.isFinite(Number(input.instance_id))
      ? Number(input.instance_id)
      : null,
    status:
      String(input.status || '')
        .trim()
        .toLowerCase() || 'unknown',
  };
}

export async function listHybridAIHandles(options) {
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('HYBRIDAI_API_KEY is required to query HybridAI handles.');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl || fetch;
  let response;

  try {
    response = await fetchImpl(`${baseUrl}/api/v1/agent-handles/`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (error) {
    throw new Error(
      `Could not reach HybridAI handle API (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(
      parseErrorMessage(
        payload,
        `HybridAI handle lookup failed with HTTP ${response.status}.`,
      ),
    );
  }

  const handles = Array.isArray(payload?.handles)
    ? payload.handles.map(normalizeHandleEntry).filter(Boolean)
    : [];

  return {
    handles,
    count: Number.isFinite(Number(payload?.count))
      ? Number(payload.count)
      : handles.length,
  };
}
