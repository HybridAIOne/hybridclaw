/**
 * Minimal routing identity for one skill eligible in the current session.
 *
 * Shared by the host and the container so the `skillCatalog` wire contract
 * cannot drift between them. Deliberately narrower than the host-side `Skill`:
 * the container only needs enough to route a request and read the SKILL.md.
 */
export interface SessionSkillCatalogEntry {
  name: string;
  description: string;
  category: string;
  location: string;
  /** Credential ids the skill declares; omitted when it declares none. */
  requiredCredentials?: string[];
}
