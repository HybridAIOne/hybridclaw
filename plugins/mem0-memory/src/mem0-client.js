function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildMissingDependencyError(error) {
  const message =
    error instanceof Error ? error.message : String(error || 'Unknown error');
  if (
    message.includes("Cannot find package 'mem0ai'") ||
    message.includes("Cannot find module 'mem0ai'") ||
    message.includes('ERR_MODULE_NOT_FOUND')
  ) {
    return new Error(
      'Mem0 SDK is not installed for plugin `mem0-memory`. Run `hybridclaw plugin install mem0-memory --yes` or `hybridclaw plugin reinstall ./plugins/mem0-memory --yes`.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}

let mem0ModulePromise = null;

async function loadMem0Module() {
  if (!mem0ModulePromise) {
    if (!normalizeString(process.env.MEM0_TELEMETRY)) {
      process.env.MEM0_TELEMETRY = 'false';
    }
    mem0ModulePromise = import('mem0ai').catch((error) => {
      mem0ModulePromise = null;
      throw buildMissingDependencyError(error);
    });
  }
  return await mem0ModulePromise;
}

function buildReadOptions(config, userId, extra = {}) {
  if (config.apiVersion === 'v2') {
    return {
      api_version: 'v2',
      filters: { user_id: userId },
      ...extra,
    };
  }
  return {
    api_version: 'v1',
    user_id: userId,
    ...extra,
  };
}

function buildWriteOptions(config, userId, agentId, extra = {}) {
  return {
    api_version: config.apiVersion,
    user_id: userId,
    agent_id: agentId,
    ...extra,
  };
}

export function normalizeMem0Results(response) {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object') {
    if (Array.isArray(response.results)) return response.results;
    if (Array.isArray(response.memories)) return response.memories;
  }
  return [];
}

export function extractMemoryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.memory === 'string' && entry.memory.trim()) {
    return entry.memory.trim();
  }
  if (
    entry.data &&
    typeof entry.data === 'object' &&
    typeof entry.data.memory === 'string' &&
    entry.data.memory.trim()
  ) {
    return entry.data.memory.trim();
  }
  if (typeof entry.text === 'string' && entry.text.trim()) {
    return entry.text.trim();
  }
  return '';
}

export class Mem0PluginClient {
  constructor(config) {
    this.config = config;
    this.clientPromise = null;
  }

  async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { MemoryClient } = await loadMem0Module();
        const client = new MemoryClient({
          apiKey: this.config.apiKey,
          host: this.config.host,
          ...(this.config.organizationId
            ? { organizationId: this.config.organizationId }
            : {}),
          ...(this.config.projectId
            ? { projectId: this.config.projectId }
            : {}),
        });
        if (client?.client?.defaults) {
          client.client.defaults.timeout = this.config.timeoutMs;
        }
        return client;
      })();
    }
    return await this.clientPromise;
  }

  async ping() {
    const client = await this.getClient();
    return await client.ping();
  }

  async getProfile(userId, config = {}) {
    const client = await this.getClient();
    const response = await client.getAll(
      buildReadOptions(this.config, userId, {
        page: 1,
        page_size: config.pageSize || this.config.profileLimit,
      }),
    );
    return normalizeMem0Results(response);
  }

  async search(userId, query, config = {}) {
    const client = await this.getClient();
    const response = await client.search(
      query,
      buildReadOptions(this.config, userId, {
        top_k: config.topK || this.config.searchLimit,
        rerank:
          typeof config.rerank === 'boolean'
            ? config.rerank
            : this.config.prefetchRerank,
      }),
    );
    return normalizeMem0Results(response);
  }

  async syncMessages(userId, agentId, messages, metadata = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const client = await this.getClient();
    return await client.add(
      messages,
      buildWriteOptions(this.config, userId, agentId, { metadata }),
    );
  }

  async storeConclusion(userId, agentId, conclusion, metadata = {}) {
    const client = await this.getClient();
    return await client.add(
      [{ role: 'user', content: conclusion }],
      buildWriteOptions(this.config, userId, agentId, {
        metadata,
        infer: false,
      }),
    );
  }
}
