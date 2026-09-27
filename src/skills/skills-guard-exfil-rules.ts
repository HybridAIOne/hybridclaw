/**
 * Skill guard exfiltration rules — secrets or data leaving through shell
 * commands, environment reads, DNS lookups, or Markdown links.
 *
 * A secret that authenticates its own request, or goes to the host named after
 * its vendor, is ordinary API use rather than exfiltration. These rules are the
 * first slice of the table in `skills-guard.ts`, which owns the verdict.
 */
import { r, type ThreatRule } from './skills-guard-text.js';

// A shell name that ENDS in a secret word; `$X_API_URL` and `$KEY_FILE` hold
// no secret. `(?!\w)` rather than `\b`: same match, half the backtracking.
const SECRET_NAME = String.raw`\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?(?!\w)`;
const SECRET_VAR = String.raw`\$\{?${SECRET_NAME}`;

// The same test for a JS or Python value (`apiKey`, `self.api_key`,
// `process.env.X_TOKEN`, `os.environ["X_API_KEY"]`, `os.getenv("X_TOKEN")`).
// A value follows an operator or bracket, so a dict key, keyword name, call,
// or word in prose or a URL path does not count. Unlike shell `$KEY`, a bare
// `key` in code is a map or object key (`requests.get(key)`, `data=key`) and
// `tokens` counts LLM tokens (`max_tokens`): decided 2026-09-27 at the owner's
// request, as every bare `key` in the corpora was one; resource names such as
// `issueKey` still count. `\x60` is a backtick.
const CODE_NAME_END = String.raw`(?:[\w$]KEYS?|TOKEN|SECRETS?|PASSWORDS?|CREDENTIALS?)`;
const CODE_SECRET = String.raw`[=:(,{+%?!|&*\[>]\s*(?:[\w$]+\??\.)*(?:[\w$]*?${CODE_NAME_END}(?![\w$'"\x60]|\s*(?:=(?!=)|:(?!:)|\())|(?:[\w$]+\s*\[|(?:getenv|get)\s*\()\s*["'\x60]\w*?${CODE_NAME_END}["'\x60])`;

// Only the first call on a line is tried: a secret after any call also follows
// the first, and retrying from every call made a line of repeated calls
// quadratic. Calls match literal-first so the regex engine can skip to them.
function firstOnLine(call: string): string {
  return String.raw`${call}(?<!${call}[^\n]*?${call})`;
}
const FETCH_CALL = String.raw`fetch(?<![\w$]fetch)\s*(?=\()`;
// `this.requests.get(key)` or `this.http.get(url)` is an object's method, not
// the requests, http, or httpx module.
const HTTPX_CALL = String.raw`http(?<![\w$.]http)x?\.(?:get|post|put|patch)\s*(?=\()`;
const REQUESTS_CALL = String.raw`requests(?<![\w$.]requests)\.(?:get|post|put|patch)\s*(?=\()`;

// Secrets used as intended: an auth header value, a basic-auth or bearer
// flag, or a URL whose host names the secret's vendor (`$TRELLO_TOKEN` on
// api.trello.com; a generic prefix such as `API_` or `AUTH_` names no vendor).
// A body, another header, or an unrelated host still counts as sending it away.
// A host holds no `$` `{` `}`, which also keeps the lookbehind short.
const VENDOR_SECRET = String.raw`(?!(?:api|app|access|auth|bearer|bot|client|private|public|refresh|secret|service|session|user)_)([a-z][a-z0-9]{2,})_\w*?(?:key|token|secret|password|credential)s?\b`;
const ON_VENDOR_HOST = String.raw`(?<=https?://[^\s/?#"'$:{}]{0,253}?\1[^\s"'<>]{0,512})`;
const SECRET_SENT_HOME = new RegExp(
  [
    String.raw`(?<![\w-])(?:authorization|(?=[\w-]{0,40}?(?:api[-_]?key|token|auth))[\w-]{1,80})\s*:\s*(?:bearer\s+|basic\s+|token\s+)?["']?\$\{?\w+\}?`,
    String.raw`(?:-u|--user|--oauth2-bearer)\s*["']?[^\s"'$]{0,64}\$\{?\w+\}?(?::\$\{?\w+\}?)?`,
    String.raw`(?=\$\{?${VENDOR_SECRET})${ON_VENDOR_HOST}\$\{?\w+\}?`,
  ].join('|'),
  'gi',
);

// The same exemptions in JS and Python: a vendor URL interpolating
// `${process.env.X_KEY}` or f-string `{X_KEY}`; a header entry named
// `Authorization` or a hyphenated api-key/token/auth name, up to the next `,`
// `;` `)` (an underscore name such as `api_key:` is a body field);
// `auth=(user, key)` or `auth=HTTPBasicAuth(...)`; a header builder such as
// `headers=_bearer(token)`.
const CODE_SECRET_SENT_HOME = new RegExp(
  [
    String.raw`(?=(?:\$\{?|\{)\s*(?:[\w$]+\??\.)*${VENDOR_SECRET})${ON_VENDOR_HOST}(?:\$?\{[\w$.?\s]*\}?|\$\w+)`,
    String.raw`[{,]\s*["'\x60]?(?:authorization|(?=[\w-]{0,40}?-)(?=[\w-]{0,40}?(?:api[-_]?key|token|auth))[\w-]{1,80})["'\x60]?\s*:\s*[^,;)\n]*`,
    String.raw`\b(?:auth\s*=\s*(?:[\w.]*\((?:[^()\n]|\([^()\n]*\))*\)|[\w.]+)|headers\s*=\s*[\w.]+\((?:[^()\n]|\([^()\n]*\))*\))`,
  ].join('|'),
  'gi',
);

// Whole-`os.environ` uses that dump nothing. A membership test reads one key,
// as `os.environ[...]` does, but a `for` loop's `in` still enumerates, as does
// `in os.environ.items()`. The environment or a copy given to `env` (the
// subprocess keyword, or the variable holding it) is what the child inherits
// anyway (call delegated by the owner, 2026-09-27). A copy under another name,
// or one filtered by iterating `.items()`, still counts: a line scan cannot
// tell it from a harvest.
const ENVIRON_NOT_DUMPED = new RegExp(
  [
    String.raw`in(?<!\win)\s+os\.environ\b(?<!\bfor\s+\(?\w+(?:\s*,\s*\w+)*\)?\s+in\s+os\.environ)(?!\s*\.)`,
    String.raw`env(?<!\wenv)\s*=\s*(?:dict\s*\(\s*|\{\s*\*\*\s*)?os\.environ\b(?:\s*\.\s*copy\s*\(\s*\))?(?!\s*\.)`,
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
    // A `$VAR` (shell-expanded around `node -e`) or a `${...}` holding a code
    // secret; the `${` scan stops at the next `$`, keeping it linear.
    regex: r(
      String.raw`${firstOnLine(FETCH_CALL)}[^\n]*(?:\$${SECRET_NAME}|\$(?=\{)[^$}\n]*?${CODE_SECRET})`,
    ),
    ignore: CODE_SECRET_SENT_HOME,
    patternId: 'env_exfil_fetch',
    severity: 'critical',
    category: 'exfiltration',
    description: 'fetch() sends an interpolated secret away from its API',
  },
  {
    regex: r(
      String.raw`${firstOnLine(HTTPX_CALL)}[^\n]*(?:\$${SECRET_NAME}|${CODE_SECRET})`,
    ),
    ignore: CODE_SECRET_SENT_HOME,
    patternId: 'env_exfil_httpx',
    severity: 'critical',
    category: 'exfiltration',
    description: 'httpx or http call sends a secret away from its API',
  },
  {
    regex: r(
      String.raw`${firstOnLine(REQUESTS_CALL)}[^\n]*(?:\$${SECRET_NAME}|${CODE_SECRET})`,
    ),
    ignore: CODE_SECRET_SENT_HOME,
    patternId: 'env_exfil_requests',
    severity: 'critical',
    category: 'exfiltration',
    description: 'requests call sends a secret away from its API',
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
    // `printenv` without a variable name (`printenv HOME` and the argv form
    // `"printenv", "HOME"` print one), or `env |`. `.env |` pipes a file,
    // `venv |` and `ProcessEnv |` are other words, and in a Markdown table row
    // (a line starting with `|`) an unescaped `|` is a cell border. The `env`
    // scan must stay anchored at the line start: unanchored it is quadratic.
    regex: r(
      String.raw`printenv(?!(?:\s+-[-\w]+)*(?:\s+["']?|["']\s*,\s*["'])[a-z_$])|^(?!\s*\|)[^\n]*?env(?<![\w.]env)\s*\|`,
    ),
    patternId: 'dump_all_env',
    severity: 'high',
    category: 'exfiltration',
    description: 'dumps all environment variables',
  },
  {
    regex: r(
      String.raw`os\.environ\b(?!\s*(?:\[|\.(?:get|setdefault|pop)\s*\())`,
    ),
    ignore: ENVIRON_NOT_DUMPED,
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
    // As python_os_environ: `process.env[NAME]` is how every helper reads its
    // config, and spreading the environment into a child process's `env` only
    // passes on what the child inherits anyway.
    regex: r(
      String.raw`(?:JSON\.stringify|Object\.(?:entries|values)|console\.\w+)\s*\(\s*(?:\{\s*\.\.\.\s*)?process\.env\s*[,)}]|for\s*\(\s*(?:const|let|var)\s+[\w$]+\s+in\s+process\.env\b`,
    ),
    patternId: 'node_process_env',
    severity: 'high',
    category: 'exfiltration',
    description: 'uses the whole process.env, not one key (potential env dump)',
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
