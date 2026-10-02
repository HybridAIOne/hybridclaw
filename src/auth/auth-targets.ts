/**
 * Auth targets — the names `hybridclaw auth login|status|logout <target>`,
 * `hybridclaw help <target>`, and the gateway's `auth status` accept.
 *
 * Model-provider targets take every synonym from `PROVIDER_ALIASES`; this
 * table adds names only for targets that are not model providers. Each name
 * resolves to exactly one target: a second claim throws at load, so lookup
 * order never decides a collision. `AUTH_STATUS_TARGETS` is the subset the
 * in-chat `/auth status` answers; its TUI menu lists exactly that subset.
 *
 * NOT the `/model list` filter (`normalizeModelCatalogProviderFilter`), which
 * knows model providers only, and NOT the per-target login/status/logout
 * dispatch, which stays in `src/cli/auth-command.ts`.
 */
import { getProviderAliasesFor } from '../providers/provider-aliases.js';
import type { RuntimeProviderId } from '../providers/provider-ids.js';

interface AuthTargetDef {
  /** Runtime provider whose id and `PROVIDER_ALIASES` synonyms name it. */
  provider?: RuntimeProviderId;
  /** Synonyms for a target that is not a model provider. */
  aliases?: readonly string[];
}

// Listed in the order error messages name the targets.
const AUTH_TARGET_DEFS = {
  hybridai: { provider: 'hybridai' },
  openai: { provider: 'openai' },
  codex: { provider: 'openai-codex' },
  anthropic: { provider: 'anthropic' },
  openrouter: { provider: 'openrouter' },
  mistral: { provider: 'mistral' },
  huggingface: { provider: 'huggingface' },
  google: { aliases: ['gog'] },
  hubspot: { aliases: ['hs'] },
  microsoft365: {
    aliases: [
      'microsoft-365',
      'm365',
      'office365',
      'office-365',
      'graph',
      'msgraph',
    ],
  },
  gemini: { provider: 'gemini' },
  deepseek: { provider: 'deepseek' },
  xai: { provider: 'xai' },
  zai: { provider: 'zai' },
  kimi: { provider: 'kimi' },
  minimax: { provider: 'minimax' },
  dashscope: { provider: 'dashscope' },
  xiaomi: { provider: 'xiaomi' },
  kilo: { provider: 'kilo' },
  local: {},
  msteams: { aliases: ['teams', 'ms-teams'] },
  slack: {},
} as const satisfies Record<string, AuthTargetDef>;

export type AuthTarget = keyof typeof AUTH_TARGET_DEFS;

export const AUTH_TARGETS = Object.keys(AUTH_TARGET_DEFS) as AuthTarget[];

/** "`hybridai`, `openai`, …, or `slack`" for unknown-target errors. */
export const AUTH_TARGET_CHOICES = `${AUTH_TARGETS.slice(0, -1)
  .map((target) => `\`${target}\``)
  .join(', ')}, or \`${AUTH_TARGETS.at(-1)}\``;

// Only `hybridclaw auth status` reports these (owner call, 2026-10-02: in-chat
// status serves the targets the TUI menu offered; gateway status for these
// four is deferred).
const CLI_ONLY_STATUS_TARGETS = [
  'anthropic',
  'google',
  'hubspot',
  'microsoft365',
] as const satisfies readonly AuthTarget[];

export type AuthStatusTarget = Exclude<
  AuthTarget,
  (typeof CLI_ONLY_STATUS_TARGETS)[number]
>;

/** The targets in-chat `/auth status` answers and its TUI menu lists. */
export const AUTH_STATUS_TARGETS = AUTH_TARGETS.filter(
  (target): target is AuthStatusTarget =>
    !(CLI_ONLY_STATUS_TARGETS as readonly AuthTarget[]).includes(target),
);

const AUTH_TARGET_BY_NAME = new Map<string, AuthTarget>();
for (const target of AUTH_TARGETS) {
  const def: AuthTargetDef = AUTH_TARGET_DEFS[target];
  const names = [
    target,
    ...(def.provider
      ? [def.provider, ...getProviderAliasesFor(def.provider)]
      : []),
    ...(def.aliases ?? []),
  ];
  for (const name of names) {
    const claimed = AUTH_TARGET_BY_NAME.get(name);
    if (claimed && claimed !== target) {
      throw new Error(
        `Auth target name "${name}" is claimed by both ${claimed} and ${target}.`,
      );
    }
    AUTH_TARGET_BY_NAME.set(name, target);
  }
}

export function resolveAuthTarget(
  rawName: string | undefined,
): AuthTarget | null {
  const name = String(rawName || '')
    .trim()
    .toLowerCase();
  return AUTH_TARGET_BY_NAME.get(name) ?? null;
}
