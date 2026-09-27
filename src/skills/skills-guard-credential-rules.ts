/**
 * Skill guard credential rules — secrets written into a skill (API keys,
 * tokens, private keys) and credentials coerced into strings in skill code.
 * These rules are the last slice of the table in `skills-guard.ts`, which owns
 * the verdict.
 */
import { r, type ThreatRule } from './skills-guard-text.js';

export const CREDENTIAL_RULES: ThreatRule[] = [
  {
    regex: r(
      String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`,
    ),
    // A quoted SHOUTY_SNAKE value names an env var; it embeds no secret.
    ignore: /["'][A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+["']/g,
    patternId: 'hardcoded_secret',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'possible hardcoded API key/token/secret',
  },
  {
    regex: r(String.raw`-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----`),
    patternId: 'embedded_private_key',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'embedded private key',
  },
  {
    regex: r(`ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}`),
    patternId: 'github_token_leaked',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'GitHub personal access token in skill content',
  },
  {
    regex: r(`sk-[A-Za-z0-9]{20,}`),
    patternId: 'openai_key_leaked',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'possible OpenAI API key in skill content',
  },
  {
    regex: r(`sk-ant-[A-Za-z0-9_-]{90,}`),
    patternId: 'anthropic_key_leaked',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'possible Anthropic API key in skill content',
  },
  {
    regex: r(`AKIA[0-9A-Z]{16}`),
    patternId: 'aws_access_key_leaked',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'AWS access key ID in skill content',
  },
  {
    regex: r(
      String.raw`\bString\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*(?:secretRef|credentialRef|secret|credential|creds?|password|token)[\w$]*\s*\)`,
    ),
    patternId: 'secret_ref_string_coercion',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'string coercion of a SecretRef or credential ref',
  },
  {
    regex: r(
      String.raw`JSON\.stringify\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*(?:secretRef|credentialRef|secret|credential|creds?|password|token)[\w$]*`,
    ),
    patternId: 'secret_ref_json_stringify',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'JSON.stringify() of a SecretRef or credential ref',
  },
  {
    regex: r(
      String.raw`\$\{\s*(?:[A-Za-z_$][\w$]*\.)?[\w$]*(?:secretRef|credentialRef|secret|credential|creds?|password|token(?!s\b))[\w$]*\s*\}`,
    ),
    // SecretRefs are JS objects: `${...}` in shell and Markdown examples is
    // parameter expansion, and `${totalTokens}` counts LLM tokens.
    skipFiles: /\.(?:md|sh|bash)$/i,
    patternId: 'secret_ref_template_interpolation',
    severity: 'critical',
    category: 'credential-exposure',
    description: 'template interpolation of a SecretRef or credential ref',
  },
];
