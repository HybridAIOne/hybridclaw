import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type SkillGuardTrustLevel =
  | 'builtin'
  | 'workspace'
  | 'personal'
  | 'community';
export type SkillGuardVerdict = 'safe' | 'caution' | 'dangerous';
export type SkillGuardSeverity = 'critical' | 'high' | 'medium' | 'low';
export type SkillGuardCategory =
  | 'exfiltration'
  | 'prompt-injection'
  | 'destructive-ops'
  | 'persistence'
  | 'reverse-shells'
  | 'obfuscation'
  | 'supply-chain'
  | 'credential-exposure'
  | 'structural';

export interface SkillGuardFinding {
  patternId: string;
  severity: SkillGuardSeverity;
  category: SkillGuardCategory;
  file: string;
  line: number;
  match: string;
  description: string;
}

export interface SkillGuardScanResult {
  skillName: string;
  skillPath: string;
  sourceTag: string;
  trustLevel: SkillGuardTrustLevel;
  verdict: SkillGuardVerdict;
  findings: SkillGuardFinding[];
  scannedAt: string;
  summary: string;
  fromCache: boolean;
}

export interface SkillGuardDecision {
  allowed: boolean;
  reason: string;
  result: SkillGuardScanResult;
}

interface ThreatRule {
  patternId: string;
  severity: SkillGuardSeverity;
  category: Exclude<SkillGuardCategory, 'structural'>;
  description: string;
  regex: RegExp;
}

interface SkillFileEntry {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
  mtimeMs: number;
  mode: number;
  isBinary: boolean;
}

interface StructureScanState {
  files: SkillFileEntry[];
  findings: SkillGuardFinding[];
  fileCount: number;
  totalSize: number;
  signatureParts: string[];
}

interface ScanCacheEntry {
  mtimeSignature: string;
  contentHash: string;
  result: SkillGuardScanResult;
}

const MAX_FILE_COUNT = 50;
const MAX_TOTAL_SIZE_BYTES = 1_024 * 1_024;
const MAX_SINGLE_FILE_BYTES = 256 * 1_024;

const SCANNABLE_EXTENSIONS = new Set<string>([
  '.md',
  '.txt',
  '.py',
  '.sh',
  '.bash',
  '.js',
  '.ts',
  '.rb',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.cfg',
  '.ini',
  '.conf',
  '.html',
  '.css',
  '.xml',
  '.tex',
  '.r',
  '.jl',
  '.pl',
  '.php',
]);

const SUSPICIOUS_BINARY_EXTENSIONS = new Set<string>([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.com',
  '.msi',
  '.dmg',
  '.app',
  '.deb',
  '.rpm',
]);

const SCRIPT_EXEC_EXTENSIONS = new Set<string>([
  '.sh',
  '.bash',
  '.py',
  '.rb',
  '.pl',
]);

const INVISIBLE_CHARS: readonly string[] = [
  '\u200b',
  '\u200c',
  '\u200d',
  '\u2060',
  '\u2062',
  '\u2063',
  '\u2064',
  '\ufeff',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
] as const;

const INVISIBLE_CHAR_NAMES: Record<string, string> = {
  '\u200b': 'zero-width space',
  '\u200c': 'zero-width non-joiner',
  '\u200d': 'zero-width joiner',
  '\u2060': 'word joiner',
  '\u2062': 'invisible times',
  '\u2063': 'invisible separator',
  '\u2064': 'invisible plus',
  '\ufeff': 'BOM/zero-width no-break space',
  '\u202a': 'LTR embedding',
  '\u202b': 'RTL embedding',
  '\u202c': 'pop directional formatting',
  '\u202d': 'LTR override',
  '\u202e': 'RTL override',
  '\u2066': 'LTR isolate',
  '\u2067': 'RTL isolate',
  '\u2068': 'first strong isolate',
  '\u2069': 'pop directional isolate',
};

const INSTALL_POLICY: Record<
  SkillGuardTrustLevel,
  Record<SkillGuardVerdict, 'allow' | 'block'>
> = {
  builtin: {
    safe: 'allow',
    caution: 'allow',
    dangerous: 'allow',
  },
  workspace: {
    safe: 'allow',
    caution: 'allow',
    dangerous: 'block',
  },
  personal: {
    safe: 'allow',
    caution: 'block',
    dangerous: 'block',
  },
  community: {
    safe: 'allow',
    caution: 'block',
    dangerous: 'block',
  },
};

const scanCache = new Map<string, ScanCacheEntry>();

function r(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

const THREAT_RULES: ThreatRule[] = [
  // exfiltration
  {
    regex: r(
      String.raw`curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`,
    ),
    patternId: 'env_exfil_curl',
    severity: 'critical',
    category: 'exfiltration',
    description: 'curl command interpolating secret environment variable',
  },
  {
    regex: r(
      String.raw`wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`,
    ),
    patternId: 'env_exfil_wget',
    severity: 'critical',
    category: 'exfiltration',
    description: 'wget command interpolating secret environment variable',
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
    regex: r(String.raw`\$HOME/\.hermes/\.env|\~/\.hermes/\.env`),
    patternId: 'hermes_env_access',
    severity: 'critical',
    category: 'exfiltration',
    description: 'directly references Hermes secrets file',
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
    regex: r(String.raw`os\.environ\b(?!\s*\.get\s*\(\s*["']PATH)`),
    patternId: 'python_os_environ',
    severity: 'high',
    category: 'exfiltration',
    description: 'accesses os.environ (potential env dump)',
  },
  {
    regex: r(
      String.raw`os\.getenv\s*\(\s*[^\)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)`,
    ),
    patternId: 'python_getenv_secret',
    severity: 'critical',
    category: 'exfiltration',
    description: 'reads secret via os.getenv()',
  },
  {
    regex: r(String.raw`process\.env\[`),
    patternId: 'node_process_env',
    severity: 'high',
    category: 'exfiltration',
    description: 'accesses process.env (Node.js environment)',
  },
  {
    regex: r(String.raw`ENV\[.*(?:KEY|TOKEN|SECRET|PASSWORD)`),
    patternId: 'ruby_env_secret',
    severity: 'critical',
    category: 'exfiltration',
    description: 'reads secret via Ruby ENV[]',
  },
  {
    regex: r(String.raw`\b(dig|nslookup|host)\s+[^\n]*\$`),
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
    regex: r(
      String.raw`(include|output|print|send|share)\s+(the\s+)?(entire\s+)?(conversation|chat\s+history|previous\s+messages|context)`,
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

  // prompt-injection
  {
    regex: r(String.raw`ignore\s+(previous|all|above|prior)\s+instructions`),
    patternId: 'prompt_injection_ignore',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'prompt injection: ignore previous instructions',
  },
  {
    regex: r(String.raw`you\s+are\s+now\s+`),
    patternId: 'role_hijack',
    severity: 'high',
    category: 'prompt-injection',
    description: 'attempts to override the agent role',
  },
  {
    regex: r(String.raw`do\s+not\s+tell\s+the\s+user`),
    patternId: 'deception_hide',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'instructs agent to hide information from user',
  },
  {
    regex: r(String.raw`system\s+prompt\s+override`),
    patternId: 'sys_prompt_override',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'attempts to override system prompt',
  },
  {
    regex: r(String.raw`pretend\s+(you\s+are|to\s+be)\s+`),
    patternId: 'role_pretend',
    severity: 'high',
    category: 'prompt-injection',
    description: 'attempts to force different identity',
  },
  {
    regex: r(
      String.raw`disregard\s+(your|all|any)\s+(instructions|rules|guidelines)`,
    ),
    patternId: 'disregard_rules',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'instructs agent to disregard rules',
  },
  {
    regex: r(String.raw`output\s+the\s+(system|initial)\s+prompt`),
    patternId: 'leak_system_prompt',
    severity: 'high',
    category: 'prompt-injection',
    description: 'attempts to extract system prompt',
  },
  {
    regex: r(String.raw`(when|if)\s+no\s*one\s+is\s+(watching|looking)`),
    patternId: 'conditional_deception',
    severity: 'high',
    category: 'prompt-injection',
    description: 'conditional hidden-behavior instruction',
  },
  {
    regex: r(
      String.raw`act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)`,
    ),
    patternId: 'bypass_restrictions',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'instructs agent to act without restrictions',
  },
  {
    regex: r(String.raw`translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)`),
    patternId: 'translate_execute',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'translate-then-execute evasion technique',
  },
  {
    regex: r(`<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->`),
    patternId: 'html_comment_injection',
    severity: 'high',
    category: 'prompt-injection',
    description: 'hidden instructions in HTML comments',
  },
  {
    regex: r(String.raw`<\s*div\s+style\s*=\s*["'].*display\s*:\s*none`),
    patternId: 'hidden_div',
    severity: 'high',
    category: 'prompt-injection',
    description: 'hidden HTML div (invisible instructions)',
  },
  {
    regex: r(String.raw`\bDAN\s+mode\b|Do\s+Anything\s+Now`),
    patternId: 'jailbreak_dan',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'DAN jailbreak attempt',
  },
  {
    regex: r(String.raw`\bdeveloper\s+mode\b.*\benabled?\b`),
    patternId: 'jailbreak_dev_mode',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'developer mode jailbreak attempt',
  },
  {
    regex: r(String.raw`hypothetical\s+scenario.*(?:ignore|bypass|override)`),
    patternId: 'hypothetical_bypass',
    severity: 'high',
    category: 'prompt-injection',
    description: 'hypothetical scenario used to bypass restrictions',
  },
  {
    regex: r(String.raw`for\s+educational\s+purposes?\s+only`),
    patternId: 'educational_pretext',
    severity: 'medium',
    category: 'prompt-injection',
    description: 'educational pretext often used to justify harmful content',
  },
  {
    regex: r(
      String.raw`(respond|answer|reply)\s+without\s+(any\s+)?(restrictions|limitations|filters|safety)`,
    ),
    patternId: 'remove_filters',
    severity: 'critical',
    category: 'prompt-injection',
    description: 'instructs agent to respond without safety filters',
  },
  {
    regex: r(String.raw`you\s+have\s+been\s+(updated|upgraded|patched)\s+to`),
    patternId: 'fake_update',
    severity: 'high',
    category: 'prompt-injection',
    description: 'fake update announcement',
  },
  {
    regex: r(
      String.raw`new\s+policy|updated\s+guidelines|revised\s+instructions`,
    ),
    patternId: 'fake_policy',
    severity: 'medium',
    category: 'prompt-injection',
    description: 'claims new policy/guidelines',
  },

  // destructive-ops
  {
    regex: r(String.raw`rm\s+-rf\s+/`),
    patternId: 'destructive_root_rm',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'recursive delete from root',
  },
  {
    regex: r(String.raw`rm\s+(-[^\s]*)?r.*\$HOME|\brmdir\s+.*\$HOME`),
    patternId: 'destructive_home_rm',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'recursive delete targeting home directory',
  },
  {
    regex: r(String.raw`chmod\s+777`),
    patternId: 'insecure_perms',
    severity: 'medium',
    category: 'destructive-ops',
    description: 'sets world-writable permissions',
  },
  {
    regex: r(String.raw`>\s*/etc/`),
    patternId: 'system_overwrite',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'overwrites system configuration file',
  },
  {
    regex: r(String.raw`\bmkfs\b`),
    patternId: 'format_filesystem',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'formats a filesystem',
  },
  {
    regex: r(String.raw`\bdd\s+.*if=.*of=/dev/`),
    patternId: 'disk_overwrite',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'raw disk write operation',
  },
  {
    regex: r(String.raw`shutil\.rmtree\s*\(\s*["'/]`),
    patternId: 'python_rmtree',
    severity: 'high',
    category: 'destructive-ops',
    description: 'Python rmtree on absolute path',
  },
  {
    regex: r(String.raw`truncate\s+-s\s*0\s+/`),
    patternId: 'truncate_system',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'truncates system file to zero bytes',
  },
  {
    regex: r(String.raw`subprocess\.(run|call|Popen|check_output)\s*\(`),
    patternId: 'python_subprocess',
    severity: 'medium',
    category: 'destructive-ops',
    description: 'Python subprocess execution',
  },
  {
    regex: r(String.raw`os\.system\s*\(`),
    patternId: 'python_os_system',
    severity: 'high',
    category: 'destructive-ops',
    description: 'os.system() shell execution',
  },
  {
    regex: r(String.raw`os\.popen\s*\(`),
    patternId: 'python_os_popen',
    severity: 'high',
    category: 'destructive-ops',
    description: 'os.popen() shell execution',
  },
  {
    regex: r(String.raw`child_process\.(exec|spawn|fork)\s*\(`),
    patternId: 'node_child_process',
    severity: 'high',
    category: 'destructive-ops',
    description: 'Node.js child_process execution',
  },
  {
    regex: r(String.raw`Runtime\.getRuntime\(\)\.exec\(`),
    patternId: 'java_runtime_exec',
    severity: 'high',
    category: 'destructive-ops',
    description: 'Java Runtime.exec() shell execution',
  },
  {
    regex: r('\\`[^\\`]*\\$\\([^)]+\\)[^\\`]*\\`'),
    patternId: 'backtick_subshell',
    severity: 'medium',
    category: 'destructive-ops',
    description: 'backtick with command substitution',
  },
  {
    regex: r(String.raw`\.\./\.\./\.\.`),
    patternId: 'path_traversal_deep',
    severity: 'high',
    category: 'destructive-ops',
    description: 'deep relative path traversal',
  },
  {
    regex: r(String.raw`\.\./\.\.`),
    patternId: 'path_traversal',
    severity: 'medium',
    category: 'destructive-ops',
    description: 'relative path traversal',
  },
  {
    regex: r(`/etc/passwd|/etc/shadow`),
    patternId: 'system_passwd_access',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'references system password files',
  },
  {
    regex: r(String.raw`/proc/self|/proc/\d+/`),
    patternId: 'proc_access',
    severity: 'high',
    category: 'destructive-ops',
    description: 'references /proc filesystem',
  },
  {
    regex: r(`/dev/shm/`),
    patternId: 'dev_shm',
    severity: 'medium',
    category: 'destructive-ops',
    description: 'references shared memory staging area',
  },
  {
    regex: r(String.raw`xmrig|stratum\+tcp|monero|coinhive|cryptonight`),
    patternId: 'crypto_mining',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'cryptocurrency mining reference',
  },
  {
    regex: r(`hashrate|nonce.*difficulty`),
    patternId: 'mining_indicators',
    severity: 'medium',
    category: 'destructive-ops',
    description: 'possible mining indicators',
  },
  {
    regex: r(String.raw`^allowed-tools\s*:`),
    patternId: 'allowed_tools_field',
    severity: 'high',
    category: 'destructive-ops',
    description: 'skill declares allowed-tools (pre-approves access)',
  },
  {
    regex: r(String.raw`\bsudo\b`),
    patternId: 'sudo_usage',
    severity: 'high',
    category: 'destructive-ops',
    description: 'uses sudo (privilege escalation)',
  },
  {
    regex: r(`setuid|setgid|cap_setuid`),
    patternId: 'setuid_setgid',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'setuid/setgid privilege escalation mechanism',
  },
  {
    regex: r(`NOPASSWD`),
    patternId: 'nopasswd_sudo',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'NOPASSWD sudoers entry',
  },
  {
    regex: r(String.raw`chmod\s+[u+]?s`),
    patternId: 'suid_bit',
    severity: 'critical',
    category: 'destructive-ops',
    description: 'sets SUID/SGID bit on file',
  },

  // persistence
  {
    regex: r(String.raw`\bcrontab\b`),
    patternId: 'persistence_cron',
    severity: 'medium',
    category: 'persistence',
    description: 'modifies cron jobs',
  },
  {
    regex: r(
      String.raw`\.(bashrc|zshrc|profile|bash_profile|bash_login|zprofile|zlogin)\b`,
    ),
    patternId: 'shell_rc_mod',
    severity: 'medium',
    category: 'persistence',
    description: 'references shell startup file',
  },
  {
    regex: r(`authorized_keys`),
    patternId: 'ssh_backdoor',
    severity: 'critical',
    category: 'persistence',
    description: 'modifies SSH authorized keys',
  },
  {
    regex: r(`ssh-keygen`),
    patternId: 'ssh_keygen',
    severity: 'medium',
    category: 'persistence',
    description: 'generates SSH keys',
  },
  {
    regex: r(String.raw`systemd.*\.service|systemctl\s+(enable|start)`),
    patternId: 'systemd_service',
    severity: 'medium',
    category: 'persistence',
    description: 'references or enables systemd service',
  },
  {
    regex: r(String.raw`/etc/init\.d/`),
    patternId: 'init_script',
    severity: 'medium',
    category: 'persistence',
    description: 'references init.d startup script',
  },
  {
    regex: r(String.raw`launchctl\s+load|LaunchAgents|LaunchDaemons`),
    patternId: 'macos_launchd',
    severity: 'medium',
    category: 'persistence',
    description: 'macOS launch agent/daemon persistence',
  },
  {
    regex: r(`/etc/sudoers|visudo`),
    patternId: 'sudoers_mod',
    severity: 'critical',
    category: 'persistence',
    description: 'modifies sudoers',
  },
  {
    regex: r(String.raw`git\s+config\s+--global\s+`),
    patternId: 'git_config_global',
    severity: 'medium',
    category: 'persistence',
    description: 'modifies global git configuration',
  },
  {
    regex: r(String.raw`AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules`),
    patternId: 'agent_config_mod',
    severity: 'critical',
    category: 'persistence',
    description: 'references agent config files (instruction persistence)',
  },
  {
    regex: r(String.raw`\.hermes/config\.yaml|\.hermes/SOUL\.md`),
    patternId: 'hermes_config_mod',
    severity: 'critical',
    category: 'persistence',
    description: 'references Hermes configuration files directly',
  },
  {
    regex: r(String.raw`\.claude/settings|\.codex/config`),
    patternId: 'other_agent_config',
    severity: 'high',
    category: 'persistence',
    description: 'references other agent configuration files',
  },

  // reverse-shells
  {
    regex: r(String.raw`\bnc\s+-[lp]|ncat\s+-[lp]|\bsocat\b`),
    patternId: 'reverse_shell',
    severity: 'critical',
    category: 'reverse-shells',
    description: 'potential reverse shell listener',
  },
  {
    regex: r(String.raw`\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b`),
    patternId: 'tunnel_service',
    severity: 'high',
    category: 'reverse-shells',
    description: 'uses tunneling service for external access',
  },
  {
    regex: r(String.raw`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}`),
    patternId: 'hardcoded_ip_port',
    severity: 'medium',
    category: 'reverse-shells',
    description: 'hardcoded IP address with port',
  },
  {
    regex: r(String.raw`0\.0\.0\.0:\d+|INADDR_ANY`),
    patternId: 'bind_all_interfaces',
    severity: 'high',
    category: 'reverse-shells',
    description: 'binds to all network interfaces',
  },
  {
    regex: r(String.raw`/bin/(ba)?sh\s+-i\s+.*>/dev/tcp/`),
    patternId: 'bash_reverse_shell',
    severity: 'critical',
    category: 'reverse-shells',
    description: 'bash reverse shell via /dev/tcp',
  },
  {
    regex: r(String.raw`python[23]?\s+-c\s+["']import\s+socket`),
    patternId: 'python_socket_oneliner',
    severity: 'critical',
    category: 'reverse-shells',
    description: 'Python one-liner socket connection (likely reverse shell)',
  },
  {
    regex: r(String.raw`socket\.connect\s*\(\s*\(`),
    patternId: 'python_socket_connect',
    severity: 'high',
    category: 'reverse-shells',
    description: 'Python socket connect to arbitrary host',
  },
  {
    regex: r(
      String.raw`webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com`,
    ),
    patternId: 'exfil_service',
    severity: 'high',
    category: 'reverse-shells',
    description: 'references known webhook/exfiltration service',
  },
  {
    regex: r(String.raw`pastebin\.com|hastebin\.com|ghostbin\.`),
    patternId: 'paste_service',
    severity: 'medium',
    category: 'reverse-shells',
    description: 'references paste service (possible staging)',
  },

  // obfuscation
  {
    regex: r(String.raw`base64\s+(-d|--decode)\s*\|`),
    patternId: 'base64_decode_pipe',
    severity: 'high',
    category: 'obfuscation',
    description: 'base64 decode piped to execution',
  },
  {
    regex: r(
      String.raw`\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}`,
    ),
    patternId: 'hex_encoded_string',
    severity: 'medium',
    category: 'obfuscation',
    description: 'hex-encoded string chain',
  },
  {
    regex: r(String.raw`\beval\s*\(\s*["']`),
    patternId: 'eval_string',
    severity: 'high',
    category: 'obfuscation',
    description: 'eval() with string argument',
  },
  {
    regex: r(String.raw`\bexec\s*\(\s*["']`),
    patternId: 'exec_string',
    severity: 'high',
    category: 'obfuscation',
    description: 'exec() with string argument',
  },
  {
    regex: r(String.raw`echo\s+[^\n]*\|\s*(bash|sh|python|perl|ruby|node)`),
    patternId: 'echo_pipe_exec',
    severity: 'critical',
    category: 'obfuscation',
    description: 'echo piped to interpreter for execution',
  },
  {
    regex: r(
      String.raw`compile\s*\(\s*[^\)]+,\s*["'].*["']\s*,\s*["']exec["']\s*\)`,
    ),
    patternId: 'python_compile_exec',
    severity: 'high',
    category: 'obfuscation',
    description: 'Python compile() with exec mode',
  },
  {
    regex: r(String.raw`getattr\s*\(\s*__builtins__`),
    patternId: 'python_getattr_builtins',
    severity: 'high',
    category: 'obfuscation',
    description: 'dynamic access to Python builtins',
  },
  {
    regex: r(String.raw`__import__\s*\(\s*["']os["']\s*\)`),
    patternId: 'python_import_os',
    severity: 'high',
    category: 'obfuscation',
    description: 'dynamic import of os module',
  },
  {
    regex: r(String.raw`codecs\.decode\s*\(\s*["']`),
    patternId: 'python_codecs_decode',
    severity: 'medium',
    category: 'obfuscation',
    description: 'codecs.decode (possible obfuscation)',
  },
  {
    regex: r(String.raw`String\.fromCharCode|charCodeAt`),
    patternId: 'js_char_code',
    severity: 'medium',
    category: 'obfuscation',
    description: 'JavaScript character code construction',
  },
  {
    regex: r(String.raw`atob\s*\(|btoa\s*\(`),
    patternId: 'js_base64',
    severity: 'medium',
    category: 'obfuscation',
    description: 'JavaScript base64 encode/decode',
  },
  {
    regex: r(String.raw`\[::-1\]`),
    patternId: 'string_reversal',
    severity: 'low',
    category: 'obfuscation',
    description: 'string reversal (possible obfuscation)',
  },
  {
    regex: r(String.raw`chr\s*\(\s*\d+\s*\)\s*\+\s*chr\s*\(\s*\d+`),
    patternId: 'chr_building',
    severity: 'high',
    category: 'obfuscation',
    description: 'building string from chr() calls',
  },
  {
    regex: r(
      String.raw`\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}`,
    ),
    patternId: 'unicode_escape_chain',
    severity: 'medium',
    category: 'obfuscation',
    description: 'chain of unicode escapes',
  },

  // supply-chain
  {
    regex: r(String.raw`curl\s+[^\n]*\|\s*(ba)?sh`),
    patternId: 'curl_pipe_shell',
    severity: 'critical',
    category: 'supply-chain',
    description: 'curl piped to shell (download-and-execute)',
  },
  {
    regex: r(String.raw`wget\s+[^\n]*-O\s*-\s*\|\s*(ba)?sh`),
    patternId: 'wget_pipe_shell',
    severity: 'critical',
    category: 'supply-chain',
    description: 'wget piped to shell (download-and-execute)',
  },
  {
    regex: r(String.raw`curl\s+[^\n]*\|\s*python`),
    patternId: 'curl_pipe_python',
    severity: 'critical',
    category: 'supply-chain',
    description: 'curl piped to Python interpreter',
  },
  {
    regex: r(String.raw`#\s*///\s*script.*dependencies`),
    patternId: 'pep723_inline_deps',
    severity: 'medium',
    category: 'supply-chain',
    description: 'PEP 723 inline script dependencies (verify pinning)',
  },
  {
    regex: r(String.raw`pip\s+install\s+(?!-r\s)(?!.*==)`),
    patternId: 'unpinned_pip_install',
    severity: 'medium',
    category: 'supply-chain',
    description: 'pip install without version pinning',
  },
  {
    regex: r(String.raw`npm\s+install\s+(?!.*@\d)`),
    patternId: 'unpinned_npm_install',
    severity: 'medium',
    category: 'supply-chain',
    description: 'npm install without version pinning',
  },
  {
    regex: r(String.raw`uv\s+run\s+`),
    patternId: 'uv_run',
    severity: 'medium',
    category: 'supply-chain',
    description: 'uv run may auto-install unpinned dependencies',
  },
  {
    regex: r(
      String.raw`(curl|wget|httpx?\.get|requests\.get|fetch)\s*[\(]?\s*["']https?://`,
    ),
    patternId: 'remote_fetch',
    severity: 'medium',
    category: 'supply-chain',
    description: 'fetches remote resource at runtime',
  },
  {
    regex: r(String.raw`git\s+clone\s+`),
    patternId: 'git_clone',
    severity: 'medium',
    category: 'supply-chain',
    description: 'clones git repository at runtime',
  },
  {
    regex: r(String.raw`docker\s+pull\s+`),
    patternId: 'docker_pull',
    severity: 'medium',
    category: 'supply-chain',
    description: 'pulls Docker image at runtime',
  },

  // credential-exposure
  {
    regex: r(
      String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`,
    ),
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
];

function pathWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeRealPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isLikelyBinary(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const sample = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
      if (bytesRead === 0) return false;
      const chunk = sample.subarray(0, bytesRead);
      if (chunk.includes(0)) return true;
      let suspicious = 0;
      for (const byte of chunk) {
        if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
      }
      return suspicious / chunk.length > 0.3;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function createFinding(finding: SkillGuardFinding): SkillGuardFinding {
  return finding;
}

function collectStructure(skillPath: string): StructureScanState {
  const rootReal = safeRealPath(skillPath);
  const state: StructureScanState = {
    files: [],
    findings: [],
    fileCount: 0,
    totalSize: 0,
    signatureParts: [],
  };

  const pendingDirs: string[] = [skillPath];
  const visitedDirs = new Set<string>([rootReal]);

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(skillPath, absolutePath) || entry.name;

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        state.fileCount += 1;
        let resolved: string | null = null;
        try {
          resolved = fs.realpathSync(absolutePath);
        } catch {
          resolved = null;
        }
        state.signatureParts.push(
          `L:${relativePath}:${Math.trunc(stat.mtimeMs)}:${resolved || 'BROKEN'}`,
        );

        if (!resolved) {
          state.findings.push(
            createFinding({
              patternId: 'broken_symlink',
              severity: 'medium',
              category: 'structural',
              file: relativePath,
              line: 0,
              match: 'broken symlink',
              description: 'broken or circular symlink',
            }),
          );
          continue;
        }

        if (!pathWithin(rootReal, resolved)) {
          state.findings.push(
            createFinding({
              patternId: 'symlink_escape',
              severity: 'critical',
              category: 'structural',
              file: relativePath,
              line: 0,
              match: `symlink -> ${resolved}`,
              description: 'symlink points outside the skill directory',
            }),
          );
        }
        continue;
      }

      if (stat.isDirectory()) {
        const resolvedDir = safeRealPath(absolutePath);
        state.signatureParts.push(
          `D:${relativePath}:${Math.trunc(stat.mtimeMs)}`,
        );
        if (!visitedDirs.has(resolvedDir)) {
          visitedDirs.add(resolvedDir);
          pendingDirs.push(absolutePath);
        }
        continue;
      }

      if (!stat.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const isBinary = isLikelyBinary(absolutePath);

      state.fileCount += 1;
      state.totalSize += stat.size;
      state.signatureParts.push(
        `F:${relativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}:${stat.mode}:${isBinary ? 1 : 0}`,
      );

      state.files.push({
        absolutePath,
        relativePath,
        extension: ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode,
        isBinary,
      });

      if (stat.size > MAX_SINGLE_FILE_BYTES) {
        state.findings.push(
          createFinding({
            patternId: 'oversized_file',
            severity: 'medium',
            category: 'structural',
            file: relativePath,
            line: 0,
            match: `${Math.trunc(stat.size / 1024)}KB`,
            description: `file is ${Math.trunc(stat.size / 1024)}KB (limit: ${Math.trunc(MAX_SINGLE_FILE_BYTES / 1024)}KB)`,
          }),
        );
      }

      if (SUSPICIOUS_BINARY_EXTENSIONS.has(ext) || isBinary) {
        state.findings.push(
          createFinding({
            patternId: 'binary_file',
            severity: 'critical',
            category: 'structural',
            file: relativePath,
            line: 0,
            match: isBinary
              ? `binary content${ext ? ` (${ext})` : ''}`
              : `binary extension: ${ext}`,
            description: 'binary/executable content should not be in a skill',
          }),
        );
      }

      if (!SCRIPT_EXEC_EXTENSIONS.has(ext) && (stat.mode & 0o111) !== 0) {
        state.findings.push(
          createFinding({
            patternId: 'unexpected_executable',
            severity: 'medium',
            category: 'structural',
            file: relativePath,
            line: 0,
            match: 'executable bit set',
            description:
              'file has executable permission but is not a recognized script type',
          }),
        );
      }
    }
  }

  if (state.fileCount > MAX_FILE_COUNT) {
    state.findings.push(
      createFinding({
        patternId: 'too_many_files',
        severity: 'medium',
        category: 'structural',
        file: '(directory)',
        line: 0,
        match: `${state.fileCount} files`,
        description: `skill has ${state.fileCount} files (limit: ${MAX_FILE_COUNT})`,
      }),
    );
  }

  if (state.totalSize > MAX_TOTAL_SIZE_BYTES) {
    state.findings.push(
      createFinding({
        patternId: 'oversized_skill',
        severity: 'high',
        category: 'structural',
        file: '(directory)',
        line: 0,
        match: `${Math.trunc(state.totalSize / 1024)}KB total`,
        description: `skill is ${Math.trunc(state.totalSize / 1024)}KB total (limit: ${Math.trunc(MAX_TOTAL_SIZE_BYTES / 1024)}KB)`,
      }),
    );
  }

  return state;
}

function scanFile(entry: SkillFileEntry): SkillGuardFinding[] {
  if (entry.isBinary) return [];
  if (
    entry.extension !== '.md' &&
    entry.relativePath !== 'SKILL.md' &&
    !SCANNABLE_EXTENSIONS.has(entry.extension)
  ) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(entry.absolutePath, 'utf-8');
  } catch {
    return [];
  }

  return scanTextContent(entry.relativePath, content);
}

function scanTextContent(
  relativePath: string,
  content: string,
): SkillGuardFinding[] {
  const normalizedPath = relativePath.trim() || 'SKILL.md';

  const lines = content.split('\n');
  const seen = new Set<string>();
  const findings: SkillGuardFinding[] = [];

  for (const rule of THREAT_RULES) {
    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = i + 1;
      const line = lines[i] || '';
      const dedupeKey = `${rule.patternId}:${lineNo}`;
      if (seen.has(dedupeKey)) continue;
      if (!rule.regex.test(line)) continue;
      seen.add(dedupeKey);
      const matched = line.trim();
      findings.push(
        createFinding({
          patternId: rule.patternId,
          severity: rule.severity,
          category: rule.category,
          file: normalizedPath,
          line: lineNo,
          match: matched.length > 120 ? `${matched.slice(0, 117)}...` : matched,
          description: rule.description,
        }),
      );
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i] || '';
    for (const char of INVISIBLE_CHARS) {
      if (!line.includes(char)) continue;
      const charName =
        INVISIBLE_CHAR_NAMES[char] ||
        `U+${char.codePointAt(0)?.toString(16).toUpperCase()}`;
      findings.push(
        createFinding({
          patternId: 'invisible_unicode',
          severity: 'high',
          category: 'prompt-injection',
          file: normalizedPath,
          line: lineNo,
          match: `U+${(char.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0')} (${charName})`,
          description: `invisible unicode character ${charName} (possible text hiding/injection)`,
        }),
      );
      break;
    }
  }

  return findings;
}

function determineVerdict(findings: SkillGuardFinding[]): SkillGuardVerdict {
  if (findings.length === 0) return 'safe';
  if (findings.some((finding) => finding.severity === 'critical'))
    return 'dangerous';
  return 'caution';
}

function buildSummary(params: {
  skillName: string;
  verdict: SkillGuardVerdict;
  findings: SkillGuardFinding[];
}): string {
  if (params.findings.length === 0) {
    return `${params.skillName}: clean scan, no threats detected`;
  }
  const categories = Array.from(
    new Set(params.findings.map((finding) => finding.category)),
  ).sort();
  return `${params.skillName}: ${params.verdict} — ${params.findings.length} finding(s) in ${categories.join(', ')}`;
}

function computeMtimeSignature(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts.sort()) hash.update(part).update('\n');
  return hash.digest('hex');
}

function computeContentHash(files: SkillFileEntry[]): string {
  const hash = createHash('sha256');
  const sortedFiles = files
    .slice()
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const file of sortedFiles) {
    hash.update(file.relativePath).update('\0');
    hash.update(String(file.size)).update('\0');
    try {
      hash.update(fs.readFileSync(file.absolutePath));
    } catch {
      hash.update('read-error');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function resolveSkillTrustLevel(
  sourceTag: string,
): SkillGuardTrustLevel {
  const normalized = sourceTag.trim().toLowerCase();
  if (normalized === 'bundled') return 'builtin';
  if (normalized === 'workspace' || normalized === 'agents-project')
    return 'workspace';
  if (
    normalized === 'codex' ||
    normalized === 'claude' ||
    normalized === 'agents-personal' ||
    normalized === 'extra'
  ) {
    return 'personal';
  }
  if (normalized === 'community') return 'community';
  return 'community';
}

function scanSkillWithCache(params: {
  skillName: string;
  skillPath: string;
  sourceTag: string;
  trustLevel: SkillGuardTrustLevel;
}): SkillGuardScanResult {
  const cacheKey = safeRealPath(params.skillPath);
  const structure = collectStructure(params.skillPath);
  const mtimeSignature = computeMtimeSignature(structure.signatureParts);

  const cached = scanCache.get(cacheKey);
  if (cached && cached.mtimeSignature === mtimeSignature) {
    return {
      ...cached.result,
      fromCache: true,
    };
  }

  const contentHash = computeContentHash(structure.files);
  if (cached && cached.contentHash === contentHash) {
    const updatedCache: ScanCacheEntry = {
      ...cached,
      mtimeSignature,
    };
    scanCache.set(cacheKey, updatedCache);
    return {
      ...cached.result,
      fromCache: true,
    };
  }

  const findings: SkillGuardFinding[] = [
    ...structure.findings,
    ...structure.files.flatMap((file) => scanFile(file)),
  ];

  const result: SkillGuardScanResult = {
    skillName: params.skillName,
    skillPath: params.skillPath,
    sourceTag: params.sourceTag,
    trustLevel: params.trustLevel,
    verdict: determineVerdict(findings),
    findings,
    scannedAt: new Date().toISOString(),
    summary: buildSummary({
      skillName: params.skillName,
      verdict: determineVerdict(findings),
      findings,
    }),
    fromCache: false,
  };

  scanCache.set(cacheKey, {
    mtimeSignature,
    contentHash,
    result,
  });

  return result;
}

function shouldAllowByPolicy(result: SkillGuardScanResult): {
  allowed: boolean;
  reason: string;
} {
  const decision = INSTALL_POLICY[result.trustLevel][result.verdict];
  if (decision === 'allow') {
    return {
      allowed: true,
      reason: `allowed (${result.trustLevel} source, ${result.verdict} verdict)`,
    };
  }
  return {
    allowed: false,
    reason: `blocked (${result.trustLevel} source + ${result.verdict} verdict, ${result.findings.length} finding(s))`,
  };
}

export function scanSkillContent(params: {
  skillName: string;
  skillPath?: string;
  sourceTag: string;
  content: string;
  fileName?: string;
}): SkillGuardScanResult {
  const trustLevel = resolveSkillTrustLevel(params.sourceTag);
  const findings = scanTextContent(
    params.fileName || 'SKILL.md',
    params.content,
  );
  const verdict = determineVerdict(findings);
  return {
    skillName: params.skillName,
    skillPath: params.skillPath || '(in-memory)',
    sourceTag: params.sourceTag,
    trustLevel,
    verdict,
    findings,
    scannedAt: new Date().toISOString(),
    summary: buildSummary({
      skillName: params.skillName,
      verdict,
      findings,
    }),
    fromCache: false,
  };
}

export function guardSkillDirectory(params: {
  skillName: string;
  skillPath: string;
  sourceTag: string;
}): SkillGuardDecision {
  const trustLevel = resolveSkillTrustLevel(params.sourceTag);
  if (trustLevel === 'builtin') {
    const result: SkillGuardScanResult = {
      skillName: params.skillName,
      skillPath: params.skillPath,
      sourceTag: params.sourceTag,
      trustLevel,
      verdict: 'safe',
      findings: [],
      scannedAt: new Date().toISOString(),
      summary: `${params.skillName}: builtin source, scan skipped`,
      fromCache: false,
    };
    return {
      allowed: true,
      reason: 'allowed (builtin source, scan skipped)',
      result,
    };
  }

  const result = scanSkillWithCache({
    skillName: params.skillName,
    skillPath: params.skillPath,
    sourceTag: params.sourceTag,
    trustLevel,
  });
  const decision = shouldAllowByPolicy(result);
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    result,
  };
}
