import type { RuntimeProviderId } from '../providers/provider-ids.js';

export type ProviderKind = RuntimeProviderId;

export type AnthropicMethod = 'api-key' | 'claude-cli';

export type {
  ContextGuardConfig,
  TaskModelKey,
  TaskModelPolicies,
  TaskModelPolicy,
} from '@hybridclaw/contracts/agent-io';

export { TASK_MODEL_KEYS } from '@hybridclaw/contracts/agent-io';
export type { McpServerConfig } from '@hybridclaw/shared/mcp-server-config';
