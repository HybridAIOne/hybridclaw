import { extractMemoryText } from './mem0-client.js';

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeToolTopK(value, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.trunc(value);
  if (normalized <= 0) return undefined;
  if (
    typeof maximum === 'number' &&
    Number.isFinite(maximum) &&
    maximum > 0
  ) {
    return Math.min(normalized, Math.trunc(maximum));
  }
  return normalized;
}

function formatMemoryList(title, entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return `${title}\nNo Mem0 memories matched.`;
  }
  return [
    title,
    ...entries.map((entry, index) => {
      const lines = [
        `[${index + 1}] ${extractMemoryText(entry) || '(empty memory)'}`,
      ];
      if (options.includeScore && typeof entry?.score === 'number') {
        lines.push(`score=${entry.score.toFixed(3)}`);
      }
      if (typeof entry?.id === 'string' && entry.id.trim()) {
        lines.push(`id=${entry.id.trim()}`);
      }
      return lines.join('\n');
    }),
  ].join('\n\n');
}

function buildToolMemoryResult(entries) {
  return entries
    .map((entry) => ({
      id: normalizeString(entry?.id),
      memory: extractMemoryText(entry),
      score: typeof entry?.score === 'number' ? entry.score : undefined,
      categories: Array.isArray(entry?.categories) ? entry.categories : [],
      user_id: normalizeString(entry?.user_id),
      agent_id: normalizeString(entry?.agent_id),
    }))
    .filter((entry) => entry.memory);
}

export class Mem0Controls {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async handleCommand(args, context) {
    const normalizedArgs = (args || [])
      .map((arg) => normalizeString(arg))
      .filter(Boolean);
    const subcommand = normalizeString(
      normalizedArgs[0] || 'status',
    ).toLowerCase();
    try {
      if (subcommand === 'profile') {
        const result = await this.runtime.fetchProfile(
          context.sessionId,
          context.userId,
        );
        return formatMemoryList(
          `Mem0 profile for ${result.userId}`,
          result.entries,
        );
      }
      if (subcommand === 'search') {
        const query = normalizeString(normalizedArgs.slice(1).join(' '));
        if (!query) return 'Usage: /mem0 search <query>';
        const result = await this.runtime.search(
          context.sessionId,
          context.userId,
          query,
        );
        return formatMemoryList(`Mem0 search for "${query}"`, result.entries, {
          includeScore: true,
        });
      }
      if (subcommand === 'conclude') {
        const conclusion = normalizeString(normalizedArgs.slice(1).join(' '));
        if (!conclusion) return 'Usage: /mem0 conclude <fact>';
        const result = await this.runtime.storeConclusion(
          context.sessionId,
          context.userId,
          null,
          conclusion,
        );
        return [
          'Saved conclusion to Mem0.',
          `User scope: ${result.userId}`,
          `Agent scope: ${result.agentId}`,
          `Conclusion: ${conclusion}`,
        ].join('\n');
      }
      return await this.runtime.buildStatusText(
        context.sessionId,
        context.userId,
        null,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown error');
      return ['Mem0 command failed.', '', message].join('\n');
    }
  }

  async handleToolProfile(_args, context) {
    const result = await this.runtime.fetchProfile(context.sessionId, '');
    return JSON.stringify(
      {
        userId: result.userId,
        count: result.entries.length,
        results: buildToolMemoryResult(result.entries),
      },
      null,
      2,
    );
  }

  async handleToolSearch(args, context) {
    const query = normalizeString(args.query);
    if (!query) {
      return JSON.stringify(
        {
          ok: false,
          error: 'mem0_search requires a query.',
        },
        null,
        2,
      );
    }
    const result = await this.runtime.search(context.sessionId, '', query, {
      topK: normalizeToolTopK(args.top_k, this.runtime.config.searchLimit),
      rerank: typeof args.rerank === 'boolean' ? args.rerank : undefined,
    });
    return JSON.stringify(
      {
        userId: result.userId,
        query,
        count: result.entries.length,
        results: buildToolMemoryResult(result.entries),
      },
      null,
      2,
    );
  }

  async handleToolConclude(args, context) {
    const conclusion = normalizeString(args.conclusion);
    if (!conclusion) {
      return JSON.stringify(
        {
          ok: false,
          error: 'mem0_conclude requires a conclusion.',
        },
        null,
        2,
      );
    }
    const result = await this.runtime.storeConclusion(
      context.sessionId,
      '',
      '',
      conclusion,
    );
    return JSON.stringify(
      {
        ok: true,
        userId: result.userId,
        agentId: result.agentId,
        conclusion,
      },
      null,
      2,
    );
  }
}
