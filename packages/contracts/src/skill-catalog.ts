/**
 * Shared host/worker skill catalog: admitted identities and complete mini-cards.
 * Ordinary instructions and credentials retain their existing access paths;
 * this wire contract carries guidance, never capabilities or permissions.
 * NOT the admission check (`@hybridclaw/shared/skill-catalog`).
 */

export interface SessionSkillCatalogEntry {
  name: string;
  description: string;
  category: string;
  location: string;
  /** Complete mini-skill body, already admitted by the host's skill filters. */
  instructions?: string;
  /** Credential ids the skill declares; omitted when it declares none. */
  requiredCredentials?: string[];
}
