function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function normalizeString(value) {
  return String(value || '').trim();
}

function truncateText(value, maxChars) {
  const normalized = normalizeString(value);
  if (!maxChars || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function encodePathSegment(value) {
  return encodeURIComponent(normalizeString(value));
}

function sanitizeIdentifier(value, fallback) {
  const normalized = normalizeString(value)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

export function buildUserPeerId(userId) {
  return `user-${sanitizeIdentifier(userId, 'anonymous')}`;
}

export function buildAgentPeerId(agentId, aiPeer) {
  return `agent-${sanitizeIdentifier(aiPeer || agentId, 'main')}`;
}

export function sanitizeHonchoSessionId(sessionId) {
  return sanitizeIdentifier(sessionId, 'session');
}

function normalizeMessageTimestamp(value) {
  const normalized = normalizeString(value);
  return normalized || undefined;
}

function chunkMessageContent(content, limit) {
  const normalized = normalizeString(content);
  if (!normalized) return [];
  if (!limit || normalized.length <= limit) return [normalized];

  const prefix = '[continued] ';
  const chunks = [];
  let remaining = normalized;
  let isFirst = true;

  while (remaining) {
    const effectiveLimit = isFirst ? limit : Math.max(1, limit - prefix.length);
    if (remaining.length <= effectiveLimit) {
      chunks.push(isFirst ? remaining : `${prefix}${remaining}`);
      break;
    }

    let cut = effectiveLimit;
    const paragraphBreak = remaining.lastIndexOf('\n\n', effectiveLimit);
    const sentenceBreak = remaining.lastIndexOf('. ', effectiveLimit);
    const wordBreak = remaining.lastIndexOf(' ', effectiveLimit);
    if (paragraphBreak > effectiveLimit * 0.6) {
      cut = paragraphBreak;
    } else if (sentenceBreak > effectiveLimit * 0.6) {
      cut = sentenceBreak + 1;
    } else if (wordBreak > effectiveLimit * 0.6) {
      cut = wordBreak;
    }

    const chunk = remaining.slice(0, cut).trim();
    if (!chunk) break;
    chunks.push(isFirst ? chunk : `${prefix}${chunk}`);
    remaining = remaining.slice(cut).trim();
    isFirst = false;
  }

  return chunks;
}

function normalizeChatResponse(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return (
    normalizeString(value.answer) ||
    normalizeString(value.output) ||
    normalizeString(value.result) ||
    normalizeString(value.content) ||
    normalizeString(value.response) ||
    ''
  );
}

export class HonchoClient {
  constructor(config) {
    this.config = config;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.workspaceReady = false;
    this.preparedConversations = new Set();
  }

  async request(method, pathname, options = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value == null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      accept: 'application/json',
      ...options.headers,
    };
    let body;
    if (options.body != null) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Honcho request failed (${response.status} ${response.statusText}): ${
          text.trim() || 'empty response body'
        }`,
      );
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async ensureWorkspace() {
    if (this.workspaceReady) return;
    await this.request('POST', '/v3/workspaces', {
      body: { id: this.config.workspaceId },
    });
    this.workspaceReady = true;
  }

  async ensurePeer(peerId, metadata) {
    await this.ensureWorkspace();
    await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/peers`,
      {
        body: {
          id: peerId,
          metadata,
        },
      },
    );
  }

  async ensureSession(sessionId) {
    await this.ensureWorkspace();
    await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions`,
      {
        body: {
          id: sessionId,
          metadata: {
            source: 'hybridclaw',
          },
        },
      },
    );
  }

  async addPeers(sessionId, peers) {
    const body = {};
    for (const peer of peers) {
      body[peer.peerId] = {
        observe_me: Boolean(peer.observeMe),
        observe_others: Boolean(peer.observeOthers),
      };
    }
    await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions/${encodePathSegment(sessionId)}/peers`,
      { body },
    );
  }

  async ensureConversation(params) {
    const honchoSessionId = sanitizeHonchoSessionId(params.honchoSessionId);
    const userPeerId = buildUserPeerId(params.userId);
    const agentPeerId = buildAgentPeerId(params.agentId, this.config.aiPeer);
    const conversationKey = `${honchoSessionId}:${userPeerId}:${agentPeerId}`;
    if (!this.preparedConversations.has(conversationKey)) {
      await this.ensurePeer(userPeerId, {
        source: 'hybridclaw',
        kind: 'user',
        hybridclaw_user_id: normalizeString(params.userId),
        display_name: normalizeString(this.config.peerName) || undefined,
      });
      await this.ensurePeer(agentPeerId, {
        source: 'hybridclaw',
        kind: 'agent',
        hybridclaw_agent_id: normalizeString(params.agentId),
        display_name:
          normalizeString(this.config.aiPeer) ||
          normalizeString(params.agentId) ||
          undefined,
      });
      await this.ensureSession(honchoSessionId);
      await this.addPeers(honchoSessionId, [
        {
          peerId: userPeerId,
          observeMe: this.config.userObserveMe,
          observeOthers: this.config.userObserveOthers,
        },
        {
          peerId: agentPeerId,
          observeMe: this.config.agentObserveMe,
          observeOthers: this.config.agentObserveOthers,
        },
      ]);
      this.preparedConversations.add(conversationKey);
    }

    return {
      honchoSessionId,
      userPeerId,
      agentPeerId,
    };
  }

  async syncMessages(params) {
    if (!Array.isArray(params.messages) || params.messages.length === 0)
      return 0;
    const { honchoSessionId, userPeerId, agentPeerId } =
      await this.ensureConversation(params);
    const payload = [];
    for (const message of params.messages) {
      const role = normalizeString(message?.role).toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      const peerId = role === 'assistant' ? agentPeerId : userPeerId;
      const chunks = chunkMessageContent(
        message?.content,
        this.config.messageMaxChars,
      );
      if (chunks.length === 0) continue;
      for (const [index, chunk] of chunks.entries()) {
        payload.push({
          peer_id: peerId,
          content: chunk,
          created_at: normalizeMessageTimestamp(message?.created_at),
          metadata: {
            source: 'hybridclaw',
            source_role: role,
            hybridclaw_message_id: Number(message?.id) || 0,
            chunk_index: index,
            chunk_count: chunks.length,
          },
        });
      }
    }
    if (payload.length === 0) return 0;
    await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions/${encodePathSegment(honchoSessionId)}/messages`,
      {
        body: {
          messages: payload,
        },
      },
    );
    return payload.length;
  }

  async addPeerMessages(params) {
    return this.syncMessages({
      ...params,
      messages: params.messages.map((content, index) => ({
        id: index + 1,
        role: params.role,
        content,
        created_at: params.createdAt,
      })),
    });
  }

  async getSessionContext(params) {
    const { honchoSessionId } = await this.ensureConversation(params);
    return await this.request(
      'GET',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions/${encodePathSegment(honchoSessionId)}/context`,
      {
        query: {
          tokens: this.config.contextTokens,
          summary: params.includeSummary ? 'true' : undefined,
          search_query: normalizeString(params.searchQuery) || undefined,
          peer_target: normalizeString(params.peerTargetId) || undefined,
          peer_perspective:
            normalizeString(params.peerPerspectiveId) || undefined,
          limit_to_session: params.limitToSession ? 'true' : undefined,
        },
      },
    );
  }

  async getPeerRepresentation(params) {
    const peerId = normalizeString(params.peerId);
    if (!peerId) return { representation: '', peer_card: [] };
    return await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/peers/${encodePathSegment(peerId)}/representation`,
      {
        body: {
          query: normalizeString(params.query) || undefined,
          target: normalizeString(params.targetPeerId) || undefined,
          session_id: normalizeString(params.honchoSessionId) || undefined,
        },
      },
    );
  }

  async chatWithPeer(params) {
    const response = await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/peers/${encodePathSegment(params.peerId)}/chat`,
      {
        body: {
          query: truncateText(params.query, this.config.dialecticMaxInputChars),
          reasoning_level: params.reasoningLevel,
          target: normalizeString(params.targetPeerId) || undefined,
          session_id: normalizeString(params.honchoSessionId) || undefined,
        },
      },
    );
    return truncateText(
      normalizeChatResponse(response),
      this.config.dialecticMaxChars,
    );
  }

  async createConclusions(params) {
    const { honchoSessionId } = await this.ensureConversation(params);
    if (!Array.isArray(params.conclusions) || params.conclusions.length === 0) {
      return 0;
    }
    const conclusions = params.conclusions
      .map((content) => normalizeString(content))
      .filter(Boolean)
      .map((content) => ({
        content,
        observer_id: params.observerPeerId,
        observed_id: params.observedPeerId,
        session_id: honchoSessionId,
      }));
    if (conclusions.length === 0) return 0;
    await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/conclusions`,
      {
        body: { conclusions },
      },
    );
    return conclusions.length;
  }

  async getQueueStatus(sessionId) {
    await this.ensureWorkspace();
    return await this.request(
      'GET',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/queue/status`,
      {
        query: {
          session_id: sanitizeHonchoSessionId(sessionId),
        },
      },
    );
  }

  async searchSession(params) {
    await this.ensureWorkspace();
    return await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions/${encodePathSegment(sanitizeHonchoSessionId(params.honchoSessionId))}/search`,
      {
        body: {
          query: params.query,
          limit: params.limit,
        },
      },
    );
  }
}

export function formatHonchoLabel(peerId, userPeerId, agentPeerId) {
  if (peerId === userPeerId) return 'user';
  if (peerId === agentPeerId) return 'assistant';
  return normalizeString(peerId) || 'peer';
}
