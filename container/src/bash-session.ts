/**
 * Bash shell state between calls. Every call starts in the workspace root,
 * the directory the file tools resolve from. Exported variables and aliases
 * are worker state: the snapshot captures the whole environment, gateway token
 * included, so it stays in the worker's temp dir and dies with it, and the
 * first call in a new worker for the same session says so. NOT the command
 * guard or approval classifier: commands arrive here already allowed.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHELL_RUNTIME_ENV_NAMES } from '@hybridclaw/shared/shell-runtime-env';
import {
  BASH_DOCKER_CWD,
  type BashProcessResult,
  runBashProcess,
  TASK_SANDBOX_FS_ENABLED,
} from './bash-process.js';
import { WORKSPACE_ROOT } from './runtime-paths.js';
import { ensureSessionStateDir, sessionStatePath } from './session-state.js';
import { haltIfShuttingDown } from './shutdown-latch.js';

type PersistentBashSession = {
  sessionId: string;
  sessionDir: string;
  snapshotPath: string;
  // Marks that this session ran bash in an earlier worker; null in a
  // docker-exec sandbox, which has no view of the session state dir.
  markerPath: string | null;
  defaultCwd: string;
  initialized: boolean;
};

type BashRunParams = {
  command: string;
  timeoutMs: number;
  runtimeEnv: Record<string, string>;
  sessionId: string;
};

let persistentBashStateEnabled = true;
let persistentBashSession: PersistentBashSession | null = null;
const PERSISTENT_BASH_SESSION_PREFIX = 'hybridclaw-shell';
const SESSION_SHELL_MARKER = 'bash-shell';
// 2026-09-10, Codex CI review: keep command contents out of process argv.
// NUL framing preserves whitespace and gives child commands an exhausted stdin.
// 2026-10-02, CodeQL alert #83: the persistent wrapper's paths ride the same
// frame ahead of the command, so argv holds only constants.
const readStdinField = (variable: string) =>
  `IFS= read -r -d '' ${variable} || exit 125`;
// A login profile may reset PATH (Debian's /etc/profile does), dropping the
// worker's entries such as the desktop app's bundled node. Append the ones it
// dropped, so the profile's own entries still win.
const RESTORE_WORKER_PATH = `${readStdinField('__hybridclaw_worker_path')}
if shopt -q login_shell; then
  IFS=: read -r -a __hybridclaw_path_dirs <<< "$__hybridclaw_worker_path"
  for __hybridclaw_dir in "\${__hybridclaw_path_dirs[@]}"; do
    [ -n "$__hybridclaw_dir" ] || continue
    case ":$PATH:" in
      *":$__hybridclaw_dir:"*) ;;
      *) PATH="\${PATH:+$PATH:}$__hybridclaw_dir" ;;
    esac
  done
  export PATH
fi`;
const STATELESS_BASH_WRAPPER_SCRIPT = `${RESTORE_WORKER_PATH}
${readStdinField('__hybridclaw_command')}
eval "$__hybridclaw_command"`;
const PERSISTENT_BASH_WRAPPER_SCRIPT = `
${readStdinField('__hybridclaw_session_dir')}
${readStdinField('__hybridclaw_snapshot')}
${readStdinField('__hybridclaw_default_cwd')}
${RESTORE_WORKER_PATH}
${readStdinField('__hybridclaw_command')}
__hybridclaw_snapshot_tmp="\${__hybridclaw_snapshot}.tmp"
umask 077
mkdir -p -- "$__hybridclaw_session_dir" || exit 125
chmod 700 "$__hybridclaw_session_dir" 2>/dev/null || true
__hybridclaw_write_snapshot() {
  {
    export -p | grep -vE '^declare -x (${SHELL_RUNTIME_ENV_NAMES.join('|')})(=|$)'
    alias -p
    echo 'shopt -s expand_aliases'
    echo 'set +e'
    echo 'set +u'
  } > "$__hybridclaw_snapshot_tmp" &&
    mv -f -- "$__hybridclaw_snapshot_tmp" "$__hybridclaw_snapshot"
}
if [ -f "$__hybridclaw_snapshot" ]; then
  source "$__hybridclaw_snapshot" 2>/dev/null || true
else
  shopt -s expand_aliases
  set +e
  set +u
fi
cd -- "$__hybridclaw_default_cwd" || exit 126
eval "$__hybridclaw_command"
__hybridclaw_ec=$?
__hybridclaw_write_snapshot || true
# Not the exit builtin: in a login shell it runs ~/.bash_logout, and under the
# command's set -e a failing logout line would replace its status.
(exit "$__hybridclaw_ec")
`.trim();

function getPersistentBashTempRoot(): string {
  if (TASK_SANDBOX_FS_ENABLED) return '/tmp';
  const resolved = String(os.tmpdir() || '').trim();
  return resolved ? path.resolve(resolved) : '/tmp';
}

async function cleanupPersistentBashSessionArtifacts(
  session: PersistentBashSession | undefined,
): Promise<void> {
  if (!session) return;
  try {
    if (TASK_SANDBOX_FS_ENABLED) {
      await runBashProcess(
        ['-c', 'IFS= read -r -d \'\' dir || exit 125; rm -rf -- "$dir"'],
        { command: session.sessionDir, timeoutMs: 5_000, runtimeEnv: {} },
      );
      return;
    }
    fs.rmSync(session.sessionDir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort; execution should not fail if temp artifacts linger.
  }
}

/** Drops this worker's shell state. */
export async function resetPersistentBashSessions(): Promise<void> {
  const session = persistentBashSession;
  persistentBashSession = null;
  await cleanupPersistentBashSessionArtifacts(session || undefined);
}

export function isPersistentBashStateEnabled(): boolean {
  return persistentBashStateEnabled;
}

/** Returns whether the setting changed. */
export function setPersistentBashStateEnabled(enabled: boolean): boolean {
  const normalized = enabled !== false;
  if (normalized === persistentBashStateEnabled) return false;
  persistentBashStateEnabled = normalized;
  void resetPersistentBashSessions();
  return true;
}

function resolveSessionMarkerPath(sessionId: string): string | null {
  if (!sessionId || TASK_SANDBOX_FS_ENABLED) return null;
  const markerPath = sessionStatePath(sessionId, SESSION_SHELL_MARKER);
  try {
    ensureSessionStateDir(markerPath);
    return markerPath;
  } catch {
    return null;
  }
}

async function getPersistentBashSession(
  sessionId: string,
): Promise<PersistentBashSession> {
  if (persistentBashSession?.sessionId === sessionId) {
    return persistentBashSession;
  }
  await resetPersistentBashSessions();

  const prefix = `${PERSISTENT_BASH_SESSION_PREFIX}-${randomUUID()}`;
  const tempRoot = getPersistentBashTempRoot();
  const joinPath = TASK_SANDBOX_FS_ENABLED ? path.posix.join : path.join;
  const sessionDir = joinPath(tempRoot, prefix);
  persistentBashSession = {
    sessionId,
    sessionDir,
    snapshotPath: joinPath(sessionDir, 'state.snapshot'),
    markerPath: resolveSessionMarkerPath(sessionId),
    defaultCwd: TASK_SANDBOX_FS_ENABLED
      ? BASH_DOCKER_CWD || '/app'
      : WORKSPACE_ROOT,
    initialized: false,
  };
  return persistentBashSession;
}

const RESTARTED_SHELL_NOTICE =
  '[The sandbox restarted since the previous bash call in this session: exported variables, aliases, and activated virtualenvs from earlier calls are gone.]';

// A docker-exec task sandbox keeps the PATH of its own image.
function workerPath(): string {
  return TASK_SANDBOX_FS_ENABLED ? '' : process.env.PATH || '';
}

/**
 * Runs one approved command. `notice` is set on the first call in a worker
 * when an earlier worker already ran bash for the session.
 */
export async function runBash(params: BashRunParams): Promise<{
  result: BashProcessResult;
  notice: string | null;
}> {
  if (!persistentBashStateEnabled) {
    await haltIfShuttingDown();
    return {
      result: await runBashProcess(
        ['-lc', STATELESS_BASH_WRAPPER_SCRIPT],
        params,
        [workerPath()],
      ),
      notice: null,
    };
  }
  const session = await getPersistentBashSession(params.sessionId);
  const notice =
    !session.initialized &&
    session.markerPath &&
    fs.existsSync(session.markerPath)
      ? RESTARTED_SHELL_NOTICE
      : null;
  await haltIfShuttingDown();
  const result = await runBashProcess(
    [
      session.initialized ? '-c' : '-lc',
      PERSISTENT_BASH_WRAPPER_SCRIPT,
      'hybridclaw-bash-wrapper',
    ],
    params,
    [
      session.sessionDir,
      session.snapshotPath,
      session.defaultCwd,
      workerPath(),
    ],
  );
  if (
    !session.initialized &&
    (result.error === undefined || result.status !== null)
  ) {
    session.initialized = true;
    if (session.markerPath) {
      try {
        fs.writeFileSync(session.markerPath, '');
      } catch {
        // Without the marker a later worker only skips its restart notice.
      }
    }
  }
  return { result, notice };
}
