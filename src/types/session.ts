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
  created_at: string;
  last_active: string;
  reset_count: number;
  reset_at: string | null;
}

export interface StoredMessage {
  id: number;
  session_id: string;
  user_id: string;
  username: string | null;
  role: string;
  content: string;
  created_at: string;
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
