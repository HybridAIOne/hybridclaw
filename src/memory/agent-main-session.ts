/**
 * An agent's main chat: the one web conversation the HybridAI apps show as the
 * agent's thread. The apps address it with the session id
 * `main-<hash of the platform user>-<persona>`, which becomes its session key,
 * so it stays the main chat across resets that give it a new instance id.
 * Side chats (`ios-<uuid>` and the like) and console chats never use `main-`.
 * The apps also keep hidden data chats (`feed-<uuid>`, `ideas-<uuid>`) whose
 * scheduled tasks write JSON the app reads with `/schedule results`.
 *
 * NOT `sessions.main_session_key`, which is the routing scope a session's
 * context is shared under; this module only names which web chat is the main one.
 */
import type { Session } from '../types/session.js';
import { withMemoryDatabase } from './database.js';
import { queryOne } from './sqlite.js';

/**
 * The agent's current main chat, or undefined when its apps never opened one.
 * There is one per agent; should several exist (a new phone user on the same
 * sandbox), the most recently active one wins.
 */
export function getAgentMainSession(agentId: string): Session | undefined {
  return withMemoryDatabase((database) =>
    queryOne<Session, [string]>(
      database,
      `SELECT *
       FROM sessions
       WHERE agent_id = ?
         AND channel_id = 'web'
         AND session_key GLOB 'main-*'
         AND is_current = 1
       ORDER BY last_active DESC
       LIMIT 1`,
      agentId,
    ),
  );
}

/**
 * A hidden chat the apps fill their For you and Ideas screens from. Its tasks
 * reply with JSON for the app, not a message for the user, so their replies
 * must stay in that chat and never reach the main chat.
 */
export function isAppDataChat(sessionKey: string): boolean {
  return /^(?:feed|ideas)-/.test(sessionKey);
}
