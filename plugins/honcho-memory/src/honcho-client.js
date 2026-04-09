function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function truncateText(value, maxChars) {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || '').trim());
}

function buildUserPeerId(userId) {
  return `user:${String(userId || '').trim()}`;
}

function buildAgentPeerId(agentId) {
  return `agent:${String(agentId || '').trim()}`;
}

function sanitizeMessageContent(value) {
  const normalized = String(value || '')
    .replace(/\r/g, '')
    .trim();
  return normalized ? truncateText(normalized, 20_000) : '';
}

function buildMessageMetadata(message, role) {
  const extraMetadata =
    message?.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? message.metadata
      : null;
  const messageId = Number(message?.id);

  return {
    ...(extraMetadata || {}),
    source: 'hybridclaw',
    source_role: role,
    hybridclaw_message_id: Number.isFinite(messageId) ? messageId : null,
    hybridclaw_username:
      typeof message?.username === 'string' ? message.username : null,
  };
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

  async addPeers(sessionId, peerIds) {
    const peers = {};
    for (const peerId of peerIds) {
      peers[peerId] = {};
    }
    await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions/${encodePathSegment(sessionId)}/peers`,
      { body: peers },
    );
  }

  async ensureConversation({ sessionId, userId, agentId }) {
    const conversationKey = `${sessionId}:${userId}:${agentId}`;
    if (this.preparedConversations.has(conversationKey)) {
      return {
        sessionId,
        userPeerId: buildUserPeerId(userId),
        agentPeerId: buildAgentPeerId(agentId),
      };
    }

    const userPeerId = buildUserPeerId(userId);
    const agentPeerId = buildAgentPeerId(agentId);
    await this.ensurePeer(userPeerId, {
      source: 'hybridclaw',
      kind: 'user',
      hybridclaw_user_id: userId,
    });
    await this.ensurePeer(agentPeerId, {
      source: 'hybridclaw',
      kind: 'agent',
      hybridclaw_agent_id: agentId,
    });
    await this.ensureSession(sessionId);
    await this.addPeers(sessionId, [userPeerId, agentPeerId]);
    this.preparedConversations.add(conversationKey);
    return { sessionId, userPeerId, agentPeerId };
  }

  async syncMessages({ sessionId, userId, agentId, messages }) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const { userPeerId, agentPeerId } = await this.ensureConversation({
      sessionId,
      userId,
      agentId,
    });
    const payload = [];
    for (const message of messages) {
      const role = String(message?.role || '').toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      const content = sanitizeMessageContent(message?.content);
      if (!content) continue;
      payload.push({
        peer_id: role === 'assistant' ? agentPeerId : userPeerId,
        content,
        created_at: String(message.created_at || '').trim() || undefined,
        metadata: buildMessageMetadata(message, role),
      });
    }
    if (payload.length === 0) return;
    await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions/${encodePathSegment(sessionId)}/messages`,
      {
        body: {
          messages: payload,
        },
      },
    );
  }

  async getSessionContext({ sessionId, userId, agentId, searchQuery }) {
    const { userPeerId, agentPeerId } = await this.ensureConversation({
      sessionId,
      userId,
      agentId,
    });
    return await this.request(
      'GET',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions/${encodePathSegment(sessionId)}/context`,
      {
        query: {
          tokens: this.config.contextTokens,
          summary: this.config.includeSummary ? 'true' : undefined,
          search_query: searchQuery || undefined,
          peer_target: userPeerId,
          peer_perspective: agentPeerId,
          limit_to_session: this.config.limitToSession ? 'true' : undefined,
        },
      },
    );
  }

  async getQueueStatus(sessionId) {
    await this.ensureWorkspace();
    return await this.request(
      'GET',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/queue/status`,
      {
        query: {
          session_id: sessionId,
        },
      },
    );
  }

  async searchSession({ sessionId, query, limit }) {
    await this.ensureWorkspace();
    return await this.request(
      'POST',
      `/v3/workspaces/${encodePathSegment(this.config.workspaceId)}/sessions/${encodePathSegment(sessionId)}/search`,
      {
        body: {
          query,
          limit,
        },
      },
    );
  }
}

export function formatHonchoLabel(peerId, userPeerId, agentPeerId) {
  if (peerId === userPeerId) return 'user';
  if (peerId === agentPeerId) return 'assistant';
  return String(peerId || '').trim() || 'peer';
}
