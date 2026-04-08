import { normalizeLower } from './normalize.js';

function normalizeBaseUrl(value) {
  const trimmed = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  return trimmed || 'https://hybridai.one';
}

const HYBRIDAI_HANDLES_TIMEOUT_MS = 10_000;

function parseErrorMessage(payload, fallback) {
  return payload?.message || payload?.error?.message || fallback;
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

  const handle = normalizeLower(input.handle);
  if (!handle) return null;

  return {
    handle,
    label: String(input.label || '').trim() || null,
    status: normalizeLower(input.status) || 'unknown',
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
      signal: AbortSignal.timeout(HYBRIDAI_HANDLES_TIMEOUT_MS),
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
    count: handles.length,
  };
}
