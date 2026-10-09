/**
 * Bash shell state between calls, split by what outlives the worker.
 *
 * The working directory is session state: it is kept in the session state
 * dir, so the next worker for the session starts where the last one stopped.
 * Exported variables and aliases are worker state: the snapshot captures the
 * whole environment, gateway token included, so it stays in the worker's temp
 * dir and dies with it, and the first call in a new worker says so. NOT the
 * command guard or approval classifier: commands arrive here already allowed;
 * this module runs them and tells the classifier where the next one starts.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHELL_RUNTIME_ENV_NAMES } from '../shared/shell-runtime-env.js';
import {
  BASH_DOCKER_CWD,
  type BashProcessResult,
  runBashProcess,
  TASK_SANDBOX_FS_ENABLED,
} from './bash-process.js';
import {
  isWithinRoot,
  resolveCanonicalPath,
  WORKSPACE_ROOT,
} from './runtime-paths.js';
import { ensureSessionStateDir, sessionStatePath } from './session-state.js';
import { haltIfShuttingDown } from './shutdown-latch.js';

type PersistentBashSession = {
  sessionId: string;
  sessionDir: string;
  snapshotPath: string;
  cwdPath: string;
  cwdOutlivesWorker: boolean;
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
const SESSION_CWD_FILE = 'bash-cwd';
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
${readStdinField('__hybridclaw_cwd_file')}
${readStdinField('__hybridclaw_default_cwd')}
${RESTORE_WORKER_PATH}
${readStdinField('__hybridclaw_command')}
__hybridclaw_snapshot_tmp="\${__hybridclaw_snapshot}.tmp"
__hybridclaw_cwd_tmp="\${__hybridclaw_cwd_file}.tmp"
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
__hybridclaw_write_cwd() {
  pwd -P > "$__hybridclaw_cwd_tmp" 2>/dev/null &&
    mv -f -- "$__hybridclaw_cwd_tmp" "$__hybridclaw_cwd_file"
}
if [ -f "$__hybridclaw_snapshot" ]; then
  source "$__hybridclaw_snapshot" 2>/dev/null || true
else
  shopt -s expand_aliases
  set +e
  set +u
fi
__hybridclaw_cwd="$__hybridclaw_default_cwd"
if [ -f "$__hybridclaw_cwd_file" ]; then
  __hybridclaw_saved_cwd="$(cat "$__hybridclaw_cwd_file" 2>/dev/null)"
  if [ -n "$__hybridclaw_saved_cwd" ]; then
    __hybridclaw_cwd="$__hybridclaw_saved_cwd"
  fi
fi
if ! cd -- "$__hybridclaw_cwd"; then
  if [ "$__hybridclaw_cwd" != "$__hybridclaw_default_cwd" ] &&
    cd -- "$__hybridclaw_default_cwd"; then
    __hybridclaw_write_cwd || true
  else
    exit 126
  fi
fi
eval "$__hybridclaw_command"
__hybridclaw_ec=$?
__hybridclaw_write_snapshot || true
__hybridclaw_write_cwd || true
exit $__hybridclaw_ec
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

/** Drops this worker's shell state; the session's working directory stays. */
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

// A docker-exec task sandbox has no view of the workspace runtime dir, so its
// shell keeps the working directory in its own /tmp, like the snapshot.
function resolveSessionCwdPath(sessionId: string): string | null {
  if (!sessionId || TASK_SANDBOX_FS_ENABLED) return null;
  const cwdPath = sessionStatePath(sessionId, SESSION_CWD_FILE);
  try {
    ensureSessionStateDir(cwdPath);
    return cwdPath;
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
  const sessionCwdPath = resolveSessionCwdPath(sessionId);
  persistentBashSession = {
    sessionId,
    sessionDir,
    snapshotPath: joinPath(sessionDir, 'state.snapshot'),
    cwdPath: sessionCwdPath ?? joinPath(sessionDir, 'state.cwd'),
    cwdOutlivesWorker: sessionCwdPath !== null,
    defaultCwd: TASK_SANDBOX_FS_ENABLED
      ? BASH_DOCKER_CWD || '/app'
      : WORKSPACE_ROOT,
    initialized: false,
  };
  return persistentBashSession;
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// An earlier worker left this session's working directory behind, so this
// worker's fresh shell has lost everything else.
function describeInheritedShell(cwdPath: string): string | null {
  let savedCwd: string;
  try {
    savedCwd = fs.readFileSync(cwdPath, 'utf-8').trim();
  } catch {
    return null;
  }
  const cwd = isDirectory(savedCwd)
    ? 'the working directory carried over'
    : 'the previous working directory is gone, so this call started in the workspace root';
  return `[The sandbox restarted since the previous bash call in this session: exported variables, aliases, and activated virtualenvs from earlier calls are gone; ${cwd}.]`;
}

// A docker-exec task sandbox keeps the PATH of its own image.
function workerPath(): string {
  return TASK_SANDBOX_FS_ENABLED ? '' : process.env.PATH || '';
}

/**
 * Runs one approved command. `notice` is set on the first call in a worker
 * that inherited the session's working directory from an earlier worker.
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
    !session.initialized && session.cwdOutlivesWorker
      ? describeInheritedShell(session.cwdPath)
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
      session.cwdPath,
      session.defaultCwd,
      workerPath(),
    ],
  );
  if (result.error === undefined || result.status !== null) {
    session.initialized = true;
  }
  return { result, notice };
}

// The real path of the directory the wrapper enters from `cwdPath`, or null
// when it starts in the workspace root instead: nothing saved yet, or the
// saved directory is gone, not a directory, or not searchable.
function enterableSavedCwd(cwdPath: string): string | null {
  try {
    // The wrapper reads it with `$(cat …)`, which drops trailing newlines.
    const savedCwd = fs.readFileSync(cwdPath, 'utf-8').replace(/\n+$/, '');
    if (!savedCwd) return null;
    const realPath = resolveCanonicalPath(
      path.resolve(WORKSPACE_ROOT, savedCwd),
    );
    fs.accessSync(realPath, fs.constants.X_OK);
    return fs.statSync(realPath).isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}

/**
 * Where the session's next bash call starts, as the approval classifier
 * resolves paths (bash-commands.ts `Cwd`): '' for the workspace root, relative
 * below it, absolute elsewhere.
 */
export function nextBashCwd(sessionId: string): string {
  // A docker-exec sandbox keeps its working directory in its own /tmp, out of
  // sight, and is checked from the workspace root (owner call, 2026-09-27):
  // treating it as unknown pinned every recursive search, which stops eval
  // runs now that full-auto never approves pinned calls. The sandbox is a
  // disposable task container that does not mount the workspace.
  if (!persistentBashStateEnabled || TASK_SANDBOX_FS_ENABLED) return '';
  const cwdPath =
    persistentBashSession?.sessionId === sessionId
      ? persistentBashSession.cwdPath
      : sessionId && sessionStatePath(sessionId, SESSION_CWD_FILE);
  const start = cwdPath ? enterableSavedCwd(cwdPath) : null;
  if (!start) return '';
  // The shell saves `pwd -P`, so compare real paths.
  const workspace = resolveCanonicalPath(WORKSPACE_ROOT);
  return isWithinRoot(start, workspace)
    ? path.relative(workspace, start)
    : start;
}
