/**
 * Plugin media host — the gateway capabilities a media plugin (image, video,
 * audio tools) needs to act on the same files and credentials the sandbox saw.
 *
 * Every read goes through the existing guards: sandbox paths through the
 * validated media-root resolver, remote URLs through the SSRF-guarded HTTPS
 * fetch. A Discord media-cache path must belong to the current turn's media.
 *
 * NOT a general file API: it resolves reads only. Plugins write outputs into
 * `api.getSessionInfo(sessionId).workspacePath` and report them under
 * `workspaceDisplayRoot`.
 */
import path from 'node:path';

import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { isSafeDiscordCdnUrl } from '../channels/discord/discord-cdn-fetch.js';
import {
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  resolveSessionMediaHostPath,
  WORKSPACE_ROOT_DISPLAY,
} from '../media/session-media-paths.js';
import { getSessionById } from '../memory/db.js';
import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import {
  fetchPublicHttpsBuffer,
  type PublicHttpsFetchOptions,
  type PublicHttpsFetchResult,
} from '../security/public-https-fetch.js';
import type { MediaContextItem } from '../types/container.js';

export interface PluginSessionModelCredentials {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string>;
}

export interface PluginMediaHost {
  /** Sandbox-visible path of the agent workspace directory. */
  readonly workspaceDisplayRoot: string;
  /** Host path for a sandbox-visible media path, or null when it is not readable. */
  resolveInputPath(
    sessionId: string,
    rawPath: string,
    media: readonly MediaContextItem[],
  ): Promise<string | null>;
  /** SSRF-guarded HTTPS GET; `discordCdnOnly` also restricts the host. */
  fetchRemote(
    url: string,
    options?: PublicHttpsFetchOptions & { discordCdnOnly?: boolean },
  ): Promise<PublicHttpsFetchResult>;
  /** Credentials of the model this session runs on, for provider fallbacks. */
  getSessionModelCredentials(
    sessionId: string,
  ): Promise<PluginSessionModelCredentials>;
}

function isUnder(displayPath: string, root: string): boolean {
  const normalized = path.posix.normalize(displayPath.replace(/\\/g, '/'));
  return normalized === root || normalized.startsWith(`${root}/`);
}

export function createPluginMediaHost(session: {
  resolveAgentId(sessionId: string): string;
  resolveWorkspaceRoot(sessionId: string): string;
}): PluginMediaHost {
  return Object.freeze({
    workspaceDisplayRoot: WORKSPACE_ROOT_DISPLAY,
    async resolveInputPath(
      sessionId: string,
      rawPath: string,
      media: readonly MediaContextItem[],
    ) {
      const trimmed = String(rawPath || '').trim();
      if (!trimmed) return null;
      if (
        isUnder(trimmed, DISCORD_MEDIA_CACHE_ROOT_DISPLAY) &&
        !media.some((item) => item.path?.trim() === trimmed)
      ) {
        return null;
      }
      return resolveSessionMediaHostPath(
        trimmed,
        session.resolveWorkspaceRoot(sessionId),
      );
    },
    async fetchRemote(
      url: string,
      options: PublicHttpsFetchOptions & { discordCdnOnly?: boolean } = {},
    ) {
      const { discordCdnOnly, ...fetchOptions } = options;
      if (discordCdnOnly && !isSafeDiscordCdnUrl(url)) {
        throw new Error('blocked_url: only Discord CDN HTTPS URLs are allowed');
      }
      return fetchPublicHttpsBuffer(url, fetchOptions);
    },
    async getSessionModelCredentials(sessionId: string) {
      const { agentId, model, chatbotId } = resolveAgentForRequest({
        agentId: session.resolveAgentId(sessionId),
        session: sessionId ? (getSessionById(sessionId) ?? null) : null,
      });
      const resolved = await resolveModelRuntimeCredentials({
        model,
        chatbotId,
        agentId,
      });
      return {
        provider: resolved.provider,
        model: resolved.model || model,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        requestHeaders: { ...resolved.requestHeaders },
      };
    },
  });
}
