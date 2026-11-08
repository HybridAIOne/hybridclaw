/**
 * Each key has one in-process tail until its last queued task releases it.
 * Explicit leases let callers hold a resolved key through their existing task;
 * this queue neither resolves identities nor owns sessions or workers.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  private enqueue(key: string) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let finish!: () => void;
    const current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.tails.set(key, current);
    return {
      previous,
      release: () => {
        finish();
        if (this.tails.get(key) === current) this.tails.delete(key);
      },
    };
  }

  /** The caller releases this lease in finally after its protected work ends. */
  async acquire(key: string): Promise<() => void> {
    const { previous, release } = this.enqueue(key);
    await previous;
    return release;
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const { previous, release } = this.enqueue(key);
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
