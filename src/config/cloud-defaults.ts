/**
 * Cloud seed defaults exclude skills that need the operator's host or LAN.
 * This trims deployment capabilities, not approval policy. Other skills backed
 * by cloud APIs and tools operating on sandbox files or browsers remain usable.
 */
// Owner call, 2026-10-05: cloud agents have no operator desktop, vault or LAN.
// Owner call, 2026-10-07: Hy's cloud sandbox also drops the Hue, Shelly and
// Fronius cloud integrations and SaaS invoice harvesting.
export const CLOUD_DISABLED_SKILLS = [
  '1password',
  'apple-calendar',
  'apple-music',
  'apple-passwords',
  'byd-battery',
  'download-platform-invoices',
  'fronius',
  'homematic',
  'hue',
  'obsidian',
  'shelly',
] as const;
