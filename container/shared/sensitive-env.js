// container/shared modules are plain JS so both the root TypeScript build and
// container runtime can import one implementation without widening tsconfig roots.
export const SENSITIVE_ENV_RULES = {
  exact: new Set([
    'ANTHROPIC_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'DOCKER_AUTH_CONFIG',
    'GH_TOKEN',
    'GIT_ASKPASS',
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'HYBRIDAI_API_KEY',
    'NPM_CONFIG__AUTH',
    'NPM_CONFIG__AUTH_TOKEN',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'SSH_AGENT_PID',
    'SSH_ASKPASS',
    'SSH_AUTH_SOCK',
  ]),
  prefixes: ['AWS_'],
  // Callers must explicitly re-add any legitimate runtime config that matches
  // these broad secret-shaped patterns.
  suffixes: [
    '_ACCESS_KEY',
    '_API_KEY',
    '_AUTH',
    '_AUTH_CONFIG',
    '_CREDENTIAL',
    '_CREDENTIALS',
    '_PASS',
    '_PASSWORD',
    '_PRIVATE_KEY',
    '_SECRET',
    '_TOKEN',
  ],
};

export function isSensitiveEnvName(name, rules = SENSITIVE_ENV_RULES) {
  const normalized = String(name || '')
    .trim()
    .toUpperCase();
  if (!normalized) return false;
  if (rules.exact.has(normalized)) return true;
  if (rules.prefixes.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  return rules.suffixes.some((suffix) => normalized.endsWith(suffix));
}

export function buildSanitizedEnv(sourceEnv) {
  if (!sourceEnv || typeof sourceEnv !== 'object' || Array.isArray(sourceEnv)) {
    throw new TypeError('buildSanitizedEnv: sourceEnv must be an object');
  }
  const env = {};
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (typeof value !== 'string') continue;
    if (isSensitiveEnvName(name)) continue;
    env[name] = value;
  }
  return env;
}
