/**
 * Conversation handles for published tools — the MCP spec's server-minted
 * handle for cross-call state (2026-07-28 has no protocol sessions).
 *
 * A handle is bound to one tool and one HybridClaw session. Once a turn stops
 * at a human approval, the handle is retired for good and the retirement is
 * persisted: MCP callers are models, so a later call on that session must
 * never be able to answer the approval. NOT the run registry (in-memory,
 * lost with the gateway); only these facts must survive a restart.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 30 days / 5,000 handles (engineering choice, 2026-09-29): long enough for
// follow-ups across a working month; bounded so the file stays small.
const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 5000;

/**
 * @typedef {object} ConversationRecord
 * @property {string} tool
 * @property {number} createdAt
 * @property {number} lastUsedAt
 * @property {number} [retiredAt]
 */

function loadState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.version === 1 && parsed.conversations) {
      return new Map(Object.entries(parsed.conversations));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return new Map();
}

export class ConversationStore {
  /**
   * @param {string} filePath
   * @param {() => number} [now]
   */
  constructor(filePath, now = Date.now) {
    this.filePath = filePath;
    this.now = now;
    /** @type {Map<string, ConversationRecord>} */
    this.conversations = loadState(filePath);
  }

  /** @returns {ConversationRecord | undefined} */
  get(id) {
    return this.conversations.get(id);
  }

  create(tool) {
    const id = `c_${randomBytes(16).toString('base64url')}`;
    const at = this.now();
    this.conversations.set(id, { tool, createdAt: at, lastUsedAt: at });
    this.prune();
    this.save();
    return id;
  }

  touch(id) {
    const record = this.conversations.get(id);
    if (!record) return;
    record.lastUsedAt = this.now();
    this.save();
  }

  retire(id) {
    const record = this.conversations.get(id);
    if (!record || record.retiredAt) return;
    record.retiredAt = this.now();
    this.save();
  }

  prune() {
    const cutoff = this.now() - IDLE_TTL_MS;
    for (const [id, record] of this.conversations) {
      if (record.lastUsedAt < cutoff) this.conversations.delete(id);
    }
    const overflow = this.conversations.size - MAX_CONVERSATIONS;
    if (overflow <= 0) return;
    const oldest = [...this.conversations.entries()]
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
      .slice(0, overflow);
    for (const [id] of oldest) this.conversations.delete(id);
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: 1,
        conversations: Object.fromEntries(this.conversations),
      }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, this.filePath);
  }
}
