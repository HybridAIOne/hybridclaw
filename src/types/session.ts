import type { ApprovalMode } from '../../container/shared/approval-mode.js';
import type { ActivityTrace } from './activity-trace.js';
import type { ArtifactMetadata } from './execution.js';
import type { RoutingTrace } from './routing-trace.js';

export type SessionShowMode = 'all' | 'thinking' | 'tools' | 'none';

export interface Session {
  id: string;
  session_key: string;
  main_session_key: string;
  is_current: number;
  legacy_session_id?: string | null;
  guild_id: string | null;
  channel_id: string;
  agent_id: string;
  chatbot_id: string | null;
  model: string | null;
  enable_rag: number;
  message_count: number;
  session_summary: string | null;
  summary_updated_at: string | null;
  compaction_count: number;
  memory_flush_at: string | null;
  full_auto_enabled: number;
  full_auto_prompt: string | null;
  full_auto_started_at: string | null;
  show_mode: SessionShowMode;
  approval_mode: ApprovalMode;
  created_at: string;
  last_active: string;
  reset_count: number;
  reset_at: string | null;
  title: string | null;
  title_source: SessionTitleSource | null;
}

export type SessionTitleSource = 'auto';

export interface StoredMessage {
  id: number;
  session_id: string;
  user_id: string;
  username: string | null;
  role: string;
  content: string;
  agent_id?: string | null;
  response_rating?: ResponseRatingValue | null;
  artifacts?: ArtifactMetadata[];
  /** Web-chat activity trace (thinking + tool calls) for assistant turns. */
  activityTrace?: ActivityTrace;
  routingTrace?: RoutingTrace;
  tool_history_json?: string | null;
  /** Attachment paths of a user turn; read with `parseMessageMedia`. */
  media_json?: string | null;
  /**
   * The dynamic context message sent just before this user message. Replayed
   * verbatim so each request is a prefix of the next one and the provider's
   * prompt cache covers the conversation history.
   */
  dynamic_context?: string | null;
  /** Provenance of the turn, e.g. 'voice' for realtime speech transcripts. */
  source?: string | null;
  /**
   * The emoji the other side reacted with: the agent's on a user message, the
   * user's on the agent's.
   */
  reaction?: string | null;
  created_at: string;
}

export type ResponseRatingValue = 'up' | 'down';

export interface ResponseRatingRecord {
  session_id: string;
  message_id: number;
  operator_user_id: string;
  rating: ResponseRatingValue;
  comment: string | null;
  agent_id: string | null;
  model: string | null;
  provider: string | null;
  skill_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ForkSessionBranchParams {
  sessionId: string;
  beforeMessageId: number;
}

export interface ForkSessionBranchResult {
  session: Session;
  copiedMessageCount: number;
}

export interface ConversationBranchVariant {
  sessionId: string;
  messageId: number;
}

export interface ConversationBranchFamily {
  anchorSessionId: string;
  anchorMessageId: number;
  variants: ConversationBranchVariant[];
}

export interface ConversationHistoryPage {
  sessionId: string;
  agentId: string | null;
  sessionKey: string | null;
  mainSessionKey: string | null;
  history: StoredMessage[];
  branchFamilies: ConversationBranchFamily[];
}

export interface CanonicalSessionMessage {
  role: string;
  content: string;
  session_id: string;
  channel_id: string | null;
  created_at: string;
}

export interface CanonicalSession {
  canonical_id: string;
  agent_id: string;
  user_id: string;
  messages: CanonicalSessionMessage[];
  compaction_cursor: number;
  compacted_summary: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface CanonicalSessionContext {
  summary: string | null;
  recent_messages: CanonicalSessionMessage[];
}
