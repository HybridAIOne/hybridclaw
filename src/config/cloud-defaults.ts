/**
 * Cloud seed defaults exclude skills that need the operator's host or LAN.
 * This trims deployment capabilities, not approval policy. Skills backed by
 * cloud APIs and tools operating on sandbox files or browsers remain usable.
 */
// Owner call, 2026-10-05: cloud agents have no operator desktop, vault or LAN.
export const CLOUD_DISABLED_SKILLS = [
  '1password',
  'apple-calendar',
  'apple-music',
  'apple-passwords',
  'byd-battery',
  'homematic',
  'obsidian',
] as const;
