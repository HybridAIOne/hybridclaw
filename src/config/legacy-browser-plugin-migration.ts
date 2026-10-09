/**
 * Legacy browser-section import — compat: remove after v0.41 (#1801).
 *
 * Through v0.39 the vendor browser providers were core and kept settings under
 * `browser.<section>`. The selected provider's section becomes a
 * `plugins.list[]` entry, which enables the bundled plugin of the same id; the
 * sections of unselected providers are dropped. v0.39 saved a clamped minimum
 * for every field the operator never set (a 1-minute, 1x1 px session, $0
 * pricing); those values are dropped so the plugin's own defaults apply
 * instead of reaching a paid API.
 *
 * Runs once: normalization drops the source section, so a plugin the operator
 * removes later is never re-enabled. NOT the plugin config validator; loading
 * the plugin still checks the result against its schema.
 */
import { isRecord } from '../utils/type-guards.js';
import { DEFAULT_RUNTIME_HOME_DIR } from './runtime-paths.js';

type LegacyUnsetValues = { [key: string]: unknown };

const LEGACY_BROWSER_PLUGIN_SECTIONS: ReadonlyArray<{
  section: string;
  pluginId: string;
  secretRef?: { key: string; credential: string };
  /** What v0.39's normalizer saved for a field the operator never set. */
  legacyUnset?: LegacyUnsetValues;
  /** The step the plugin still needs after the import. */
  notice?: string;
}> = [
  {
    section: 'camofox',
    pluginId: 'camofox',
    // The bundled copy ships without camoufox-js or the browser binary.
    notice: `the camofox plugin needs its dependencies before the first browser call: run \`hybridclaw plugin install camofox\`, then \`npx camoufox-js fetch\` in ${DEFAULT_RUNTIME_HOME_DIR}/plugins/camofox`,
  },
  {
    section: 'managedCloud',
    pluginId: 'managed-cloud',
    secretRef: {
      key: 'poolTokenRef',
      credential: 'MANAGED_BROWSER_POOL_TOKEN',
    },
    legacyUnset: { pricing: { browserUsdPerMinute: 0, actionUsd: 0 } },
  },
  {
    section: 'browserUseCloud',
    pluginId: 'browser-use-cloud',
    secretRef: { key: 'apiKeyRef', credential: 'BROWSER_USE_API_KEY' },
    legacyUnset: {
      browser: {
        timeoutMinutes: 1,
        browserScreenWidth: 1,
        browserScreenHeight: 1,
      },
      // A saved 0 would zero the plugin's per-minute usage metering.
      pricing: { browserUsdPerMinute: 0, actionUsd: 0 },
    },
  },
  { section: 'macCua', pluginId: 'mac-cua' },
];

function withoutUnset(
  value: Record<string, unknown>,
  unset: LegacyUnsetValues,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === '') continue;
    const unsetEntry = unset[key];
    if (entry === unsetEntry) continue;
    if (isRecord(entry) && isRecord(unsetEntry)) {
      const nested = withoutUnset(entry, unsetEntry);
      if (Object.keys(nested).length > 0) kept[key] = nested;
      continue;
    }
    kept[key] = entry;
  }
  return kept;
}

export function migrateLegacyBrowserPluginConfig(
  rawBrowser: Record<string, unknown>,
  rawPlugins: Record<string, unknown>,
): Record<string, unknown> {
  const list = Array.isArray(rawPlugins.list) ? [...rawPlugins.list] : [];
  const provider =
    typeof rawBrowser.provider === 'string'
      ? rawBrowser.provider.trim().toLowerCase()
      : '';
  const legacy = LEGACY_BROWSER_PLUGIN_SECTIONS.find(
    (entry) => entry.pluginId === provider,
  );
  const section = legacy ? rawBrowser[legacy.section] : undefined;
  if (
    !legacy ||
    !isRecord(section) ||
    list.some((entry) => isRecord(entry) && entry.id === legacy.pluginId)
  ) {
    return rawPlugins;
  }
  const settings = { ...section };
  if (legacy.secretRef) {
    const ref = settings[legacy.secretRef.key];
    delete settings[legacy.secretRef.key];
    const refId = isRecord(ref) ? ref.id : undefined;
    if (typeof refId === 'string' && refId !== legacy.secretRef.credential) {
      console.warn(
        `[runtime-config] the ${legacy.pluginId} plugin reads its secret from ${legacy.secretRef.credential}; store it under that name with \`hybridclaw secret set ${legacy.secretRef.credential} <value>\``,
      );
    }
  }
  console.warn(
    `[runtime-config] moved browser.${legacy.section} into plugins.list[] and enabled the bundled ${legacy.pluginId} browser provider plugin`,
  );
  if (legacy.notice) console.warn(`[runtime-config] ${legacy.notice}`);
  list.push({
    id: legacy.pluginId,
    enabled: true,
    config: withoutUnset(settings, legacy.legacyUnset || {}),
  });
  return { ...rawPlugins, list };
}
