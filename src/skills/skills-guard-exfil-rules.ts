/**
 * Skill guard exfiltration rules — secrets or data leaving through shell
 * commands, environment reads, DNS lookups, or Markdown links.
 *
 * A secret that authenticates its own request, or goes to the host named after
 * its vendor, is ordinary API use rather than exfiltration. These rules are the
 * first slice of the table in `skills-guard.ts`, which owns the verdict.
 */
import { r, type ThreatRule } from './skills-guard-text.js';

// A variable whose name ENDS in a secret word; `$X_API_URL` and `$KEY_FILE`
// hold no secret. `(?!\w)` rather than `\b`: same match, half the backtracking.
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?(?!\w)`;

// Secrets used as intended: an auth header value, a basic-auth or bearer
// flag, or a URL whose host names the secret's vendor (`$TRELLO_TOKEN` on
// api.trello.com; a generic prefix such as `API_` or `AUTH_` names no vendor).
// A body, another header, or an unrelated host still counts as sending it away.
const SECRET_SENT_HOME = new RegExp(
  [
    String.raw`(?<![\w-])(?:authorization|(?=[\w-]{0,40}?(?:api[-_]?key|token|auth))[\w-]{1,80})\s*:\s*(?:bearer\s+|basic\s+|token\s+)?["']?\$\{?\w+\}?`,
    String.raw`(?:-u|--user|--oauth2-bearer)\s*["']?[^\s"'$]{0,64}\$\{?\w+\}?(?::\$\{?\w+\}?)?`,
    String.raw`(?=\$\{?(?!(?:api|app|access|auth|bearer|bot|client|private|public|refresh|secret|service|session|user)_)([a-z][a-z0-9]{2,})_\w*?(?:key|token|secret|password|credential)s?\b)(?<=https?://[^\s/?#"'$:]{0,253}?\1[^\s"'<>]{0,512})\$\{?\w+\}?`,
  ].join('|'),
  'gi',
);

export const EXFILTRATION_RULES: ThreatRule[] = [
  {
    regex: r(String.raw`curl\s+[^\n]*${SECRET_VAR}`),
    ignore: SECRET_SENT_HOME,
    patternId: 'env_exfil_curl',
    severity: 'critical',
    category: 'exfiltration',
    description: 'curl sends a secret environment variable away from its API',
  },
  {
    regex: r(String.raw`wget\s+[^\n]*${SECRET_VAR}`),
    ignore: SECRET_SENT_HOME,
    patternId: 'env_exfil_wget',
    severity: 'critical',
    category: 'exfiltration',
    description: 'wget sends a secret environment variable away from its API',
  },
  {
    regex: r(
      String.raw`fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)`,
    ),
    patternId: 'env_exfil_fetch',
    severity: 'critical',
    category: 'exfiltration',
    description: 'fetch() call interpolating secret environment variable',
  },
  {
    regex: r(
      String.raw`httpx?\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)`,
    ),
    patternId: 'env_exfil_httpx',
    severity: 'critical',
    category: 'exfiltration',
    description: 'HTTP library call with secret variable',
  },
  {
    regex: r(
      String.raw`requests\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)`,
    ),
    patternId: 'env_exfil_requests',
    severity: 'critical',
    category: 'exfiltration',
    description: 'requests library call with secret variable',
  },
  {
    regex: r(String.raw`base64[^\n]*env`),
    patternId: 'encoded_exfil',
    severity: 'high',
    category: 'exfiltration',
    description: 'base64 encoding combined with environment access',
  },
  {
    regex: r(String.raw`\$HOME/\.ssh|\~/\.ssh`),
    patternId: 'ssh_dir_access',
    severity: 'high',
    category: 'exfiltration',
    description: 'references user SSH directory',
  },
  {
    regex: r(String.raw`\$HOME/\.aws|\~/\.aws`),
    patternId: 'aws_dir_access',
    severity: 'high',
    category: 'exfiltration',
    description: 'references user AWS credentials directory',
  },
  {
    regex: r(String.raw`\$HOME/\.gnupg|\~/\.gnupg`),
    patternId: 'gpg_dir_access',
    severity: 'high',
    category: 'exfiltration',
    description: 'references user GPG keyring',
  },
  {
    regex: r(String.raw`\$HOME/\.kube|\~/\.kube`),
    patternId: 'kube_dir_access',
    severity: 'high',
    category: 'exfiltration',
    description: 'references Kubernetes config directory',
  },
  {
    regex: r(String.raw`\$HOME/\.docker|\~/\.docker`),
    patternId: 'docker_dir_access',
    severity: 'high',
    category: 'exfiltration',
    description: 'references Docker config directory',
  },
  {
    // Mirrors runtime-secrets.ts (a test keeps them in sync); importing it
    // here would break every test that mocks that module partially.
    regex: r(
      String.raw`\.hybridclaw/credentials\.json|credentials\.master\.key|hybridclaw_master_key`,
    ),
    patternId: 'runtime_secrets_access',
    severity: 'critical',
    category: 'exfiltration',
    description: "references HybridClaw's secret store or master key",
  },
  {
    regex: r(
      String.raw`cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`,
    ),
    patternId: 'read_secrets_file',
    severity: 'critical',
    category: 'exfiltration',
    description: 'reads known secrets file',
  },
  {
    regex: r(String.raw`printenv|env\s*\|`),
    patternId: 'dump_all_env',
    severity: 'high',
    category: 'exfiltration',
    description: 'dumps all environment variables',
  },
  {
    regex: r(
      String.raw`os\.environ\b(?!\s*(?:\[|\.(?:get|setdefault|pop)\s*\())`,
    ),
    patternId: 'python_os_environ',
    severity: 'high',
    category: 'exfiltration',
    description: 'uses the whole os.environ, not one key (potential env dump)',
  },
  {
    // medium (owner call, 2026-09-27): reading an API key from the environment
    // is how every client authenticates, so it must not block at every trust
    // level. Downgraded, not narrowed: the read can feed a request on a later
    // line that a line scanner cannot connect. Applies to ruby_env_secret too.
    regex: r(
      String.raw`os\.getenv\s*\(\s*[^\)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)`,
    ),
    patternId: 'python_getenv_secret',
    severity: 'medium',
    category: 'exfiltration',
    description: 'reads a secret via os.getenv() (usual API-key access)',
  },
  {
    regex: r(String.raw`process\.env\[`),
    patternId: 'node_process_env',
    severity: 'high',
    category: 'exfiltration',
    description: 'accesses process.env (Node.js environment)',
  },
  {
    // Case-sensitive, so Python `env[...]` and JS `process.env[key]` do not
    // match (Node 22 lacks `(?-i:)`). Medium: see python_getenv_secret.
    regex: /\bENV\[.*(?:KEY|TOKEN|SECRET|PASSWORD)/,
    patternId: 'ruby_env_secret',
    severity: 'medium',
    category: 'exfiltration',
    description: 'reads a secret via Ruby ENV[] (usual API-key access)',
  },
  {
    // The queried name (first argument after options) carries the `$`, so
    // `--host "$HOST"` and the word "host" in prose do not match.
    regex: r(
      String.raw`(?<!-)\b(?:dig|nslookup|host)\s+(?:[-+@]\S*(?:\s+[^\s$"'@+-][^\s$]*)?\s+)*["']?[^\s"'$]*\$`,
    ),
    patternId: 'dns_exfil',
    severity: 'critical',
    category: 'exfiltration',
    description:
      'DNS lookup with variable interpolation (possible DNS exfiltration)',
  },
  {
    regex: r(String.raw`>\s*/tmp/[^\s]*\s*&&\s*(curl|wget|nc|python)`),
    patternId: 'tmp_staging',
    severity: 'critical',
    category: 'exfiltration',
    description: 'writes to /tmp then exfiltrates',
  },
  {
    regex: r(String.raw`!\[.*\]\(https?://[^\)]*\$\{?`),
    patternId: 'md_image_exfil',
    severity: 'high',
    category: 'exfiltration',
    description: 'markdown image URL with variable interpolation',
  },
  {
    regex: r(String.raw`\[.*\]\(https?://[^\)]*\$\{?`),
    patternId: 'md_link_exfil',
    severity: 'high',
    category: 'exfiltration',
    description: 'markdown link with variable interpolation',
  },
  {
    // Bare "context" is everyday advice ("include context in properties").
    regex: r(
      String.raw`(include|output|print|send|share)\s+(the\s+)?((entire\s+)?(conversation|chat\s+history|previous\s+messages)|entire\s+context)`,
    ),
    patternId: 'context_exfil',
    severity: 'high',
    category: 'exfiltration',
    description: 'instructs agent to output/share conversation history',
  },
  {
    regex: r(
      String.raw`(send|post|upload|transmit)\s+.*\s+(to|at)\s+https?://`,
    ),
    patternId: 'send_to_url',
    severity: 'high',
    category: 'exfiltration',
    description: 'instructs agent to send data to a URL',
  },
];
