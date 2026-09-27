import { EventEmitter } from 'node:events';

/**
 * `spawn` under file-descriptor exhaustion, as Node 22 behaves (probed
 * 2026-09-26): the child comes back with stdin/stdout/stderr undefined,
 * despite the types, then emits 'error' (EMFILE) and 'close' on the next
 * tick. Code that touches stdio before listening for 'error' throws, and the
 * unheard 'error' becomes an uncaught exception that exits the gateway.
 */
export function makeStdiolessChildProcess(
  command: string,
  args: readonly string[] = [],
) {
  const error = Object.assign(new Error(`spawn ${command} EMFILE`), {
    code: 'EMFILE',
    errno: -24,
    syscall: `spawn ${command}`,
    path: command,
    spawnargs: [...args],
  });
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null as number | null,
    kill: () => false,
  });
  process.nextTick(() => {
    child.exitCode = error.errno;
    child.emit('error', error);
    child.emit('close', child.exitCode, null);
  });
  return child;
}

/**
 * Settles `run()`, lets pending next-tick spawn events fire, and returns the
 * outcome with every exception that reached `process` in the meantime.
 */
export async function settleCatchingUncaught<T>(run: () => Promise<T>) {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error);
  };
  process.on('uncaughtException', onUncaught);
  try {
    const [outcome] = await Promise.allSettled([run()]);
    await new Promise((resolve) => setImmediate(resolve));
    return { outcome, uncaught };
  } finally {
    process.off('uncaughtException', onUncaught);
  }
}
