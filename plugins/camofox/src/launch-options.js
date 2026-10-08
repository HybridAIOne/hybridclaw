/**
 * Validates the plugin's `launchOptions` against the camoufox-js options
 * HybridClaw passes through. The profile directory, headless mode, and launch
 * timeout stay owned by the provider; anything else unknown is rejected so a
 * typo fails the plugin load instead of launching a different browser.
 */

const MANAGED_KEYS = new Set(['headless', 'timeout', 'user_data_dir']);

const BOOLEAN_KEYS = new Set([
  'block_images',
  'block_webrtc',
  'block_webgl',
  'disable_coop',
  'custom_fonts_only',
  'main_world_eval',
  'enable_cache',
  'debug',
]);

const ALLOWED_KEYS = new Set([
  ...BOOLEAN_KEYS,
  'os',
  'geoip',
  'humanize',
  'locale',
  'addons',
  'fonts',
  'exclude_addons',
  'screen',
  'window',
  'fingerprint',
  'ff_version',
  'executable_path',
  'firefox_user_prefs',
  'proxy',
  'args',
  'env',
  'virtual_display',
  'webgl_config',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOption(condition, path, expected) {
  if (!condition) throw new Error(`${path} must be ${expected}.`);
}

function normalizeStringList(value, path) {
  assertOption(Array.isArray(value), path, 'an array of strings');
  return value.map((item) => {
    assertOption(
      typeof item === 'string' && item.trim().length > 0,
      path,
      'an array of non-empty strings',
    );
    return item.trim();
  });
}

function normalizeOsList(value, path) {
  const expected = '"windows", "macos", "linux", or an array of those values';
  const normalizeOs = (item) => {
    assertOption(typeof item === 'string', path, expected);
    const normalized = item.trim().toLowerCase();
    assertOption(
      normalized === 'windows' ||
        normalized === 'macos' ||
        normalized === 'linux',
      path,
      expected,
    );
    return normalized;
  };
  if (Array.isArray(value)) {
    assertOption(value.length > 0, path, 'a non-empty OS array');
    return value.map((item) => normalizeOs(item));
  }
  return normalizeOs(value);
}

function normalizeTuple(value, path, isItem, expected) {
  assertOption(
    Array.isArray(value) && value.length === 2 && value.every(isItem),
    path,
    expected,
  );
  return value.map((item) => (typeof item === 'string' ? item.trim() : item));
}

function normalizeEnv(value, path) {
  assertOption(isRecord(value), path, 'an object');
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    assertOption(key.trim().length > 0, path, 'an object with non-empty keys');
    assertOption(
      typeof entry === 'string' ||
        typeof entry === 'number' ||
        typeof entry === 'boolean',
      `${path}.${key}`,
      'a string, number, or boolean',
    );
    normalized[key] = entry;
  }
  return normalized;
}

function normalizeProxy(value, path) {
  if (typeof value === 'string') {
    assertOption(
      value.trim().length > 0,
      path,
      'a non-empty string or proxy object',
    );
    return value.trim();
  }
  assertOption(isRecord(value), path, 'a non-empty string or proxy object');
  assertOption(
    typeof value.server === 'string' && value.server.trim().length > 0,
    `${path}.server`,
    'a non-empty string',
  );
  const proxy = { server: value.server.trim() };
  for (const key of ['bypass', 'username', 'password']) {
    const entry = value[key];
    if (entry === undefined) continue;
    assertOption(typeof entry === 'string', `${path}.${key}`, 'a string');
    proxy[key] = entry;
  }
  return proxy;
}

export function normalizeCamofoxLaunchOptions(value) {
  if (value === undefined || value === null) return {};
  assertOption(isRecord(value), 'launchOptions', 'an object');

  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    const path = `launchOptions.${key}`;
    if (MANAGED_KEYS.has(key)) {
      throw new Error(
        `${path} is managed by HybridClaw; use the plugin's headed setting or SessionOptions instead.`,
      );
    }
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`${path} is not a supported Camofox launch option.`);
    }
    if (BOOLEAN_KEYS.has(key)) {
      assertOption(typeof entry === 'boolean', path, 'a boolean');
      normalized[key] = entry;
      continue;
    }

    switch (key) {
      case 'os':
        normalized.os = normalizeOsList(entry, path);
        break;
      case 'geoip':
        assertOption(
          typeof entry === 'boolean' ||
            (typeof entry === 'string' && entry.trim().length > 0),
          path,
          'a boolean or non-empty string',
        );
        normalized.geoip = typeof entry === 'string' ? entry.trim() : entry;
        break;
      case 'humanize':
        assertOption(
          typeof entry === 'boolean' ||
            (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0),
          path,
          'a boolean or non-negative number',
        );
        normalized.humanize = entry;
        break;
      case 'locale':
        if (Array.isArray(entry)) {
          normalized.locale = normalizeStringList(entry, path);
          break;
        }
        assertOption(
          typeof entry === 'string' && entry.trim().length > 0,
          path,
          'a non-empty string or array of strings',
        );
        normalized.locale = entry.trim();
        break;
      case 'addons':
      case 'fonts':
      case 'args':
        normalized[key] = normalizeStringList(entry, path);
        break;
      case 'exclude_addons':
        assertOption(
          Array.isArray(entry) && entry.every((item) => item === 'UBO'),
          path,
          'an array containing only "UBO"',
        );
        normalized.exclude_addons = [...entry];
        break;
      case 'window':
        normalized.window = normalizeTuple(
          entry,
          path,
          (item) => typeof item === 'number' && Number.isFinite(item),
          'a two-item number tuple',
        );
        break;
      case 'webgl_config':
        normalized.webgl_config = normalizeTuple(
          entry,
          path,
          (item) => typeof item === 'string' && item.trim().length > 0,
          'a two-item non-empty string tuple',
        );
        break;
      case 'ff_version':
        assertOption(
          typeof entry === 'number' && Number.isInteger(entry) && entry > 0,
          path,
          'a positive integer',
        );
        normalized.ff_version = entry;
        break;
      case 'executable_path':
      case 'virtual_display':
        assertOption(
          typeof entry === 'string' && entry.trim().length > 0,
          path,
          'a non-empty string',
        );
        normalized[key] = entry.trim();
        break;
      case 'env':
        normalized.env = normalizeEnv(entry, path);
        break;
      case 'screen':
      case 'fingerprint':
      case 'firefox_user_prefs':
        assertOption(isRecord(entry), path, 'an object');
        normalized[key] = structuredClone(entry);
        break;
      case 'proxy':
        normalized.proxy = normalizeProxy(entry, path);
        break;
    }
  }
  return normalized;
}
