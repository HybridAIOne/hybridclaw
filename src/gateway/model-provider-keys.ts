import type { RuntimeProviderId } from '../providers/provider-ids.js';

export type GatewayModelProviderKey =
  | Exclude<RuntimeProviderId, 'openai-codex'>
  | 'codex';
