/**
 * Discovered MCP metadata stays separate from operator scheduling declarations.
 * Approval consumes kind/annotations; parallelSafe also identifies reviewed
 * reads eligible for direct schemas, without granting execution permission.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../../shared/mcp-server-config.js';
import type { ToolKind } from './tool-classifier.js';

export type { McpServerConfig } from '../../shared/mcp-server-config.js';

export interface McpToolDefinition {
  serverName: string;
  name: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
  annotations?: ToolAnnotations;
  /**
   * The server asks to keep this tool's schema out of the prompt until it is
   * needed (`_meta` `DEFER_LOADING_META`), e.g. HybridAI's catalog tools.
   */
  deferLoading?: boolean;
}

/**
 * MCP `_meta` key a server sets on a tool that is rarely needed: the runtime
 * then lists it by name behind `tool_catalog` instead of as a function.
 */
export const DEFER_LOADING_META = 'hybridai/deferLoading';

/**
 * Boost handshake with the HybridAI server (`container/shared/boost-offer.js`):
 * every call says the runtime can ask the user (`BOOST_OFFERS_META`), a result
 * may carry an offer (`BOOST_OFFER_META`), and the repeated call carries the
 * user's answer (`BOOST_META`). All three ride in request or result `_meta`.
 */
export const BOOST_OFFERS_META = 'hybridai/boostOffers';
export const BOOST_OFFER_META = 'hybridai/boostOffer';
export const BOOST_META = 'hybridai/boost';

/** Approval metadata plus an independent, operator-trusted scheduling decision. */
export type McpToolBehavior = Pick<
  McpToolDefinition,
  'kind' | 'annotations'
> & {
  parallelSafe?: boolean;
};

/** HTTP/SSE request headers, read on every request. */
export interface LiveHeaders {
  current: Record<string, string>;
}

export interface McpClientHandle {
  serverName: string;
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  /** Swapped in place when the gateway rotates the token; none for stdio. */
  headers?: LiveHeaders;
  tools: McpToolDefinition[];
  /** When `tools` was last listed from the server (epoch ms). */
  listedAt: number;
  healthy: boolean;
  lastError?: string;
}
