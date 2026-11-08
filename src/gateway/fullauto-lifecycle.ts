/**
 * Full-auto timers and completions belong to one schedule or run identity.
 * A due continuation waits for its running predecessor; stale callbacks cannot
 * revive a disposed runtime. This does not persist goals or choose retry policy.
 */
type Schedule = {
  timer: ReturnType<typeof setTimeout>;
  due: boolean;
  run: () => void;
};
type State =
  | { kind: 'idle' }
  | { kind: 'scheduled'; next: Schedule }
  | {
      kind: 'running' | 'stopping';
      token: number;
      interrupted: boolean;
      next?: Schedule;
    }
  | { kind: 'disposed' };

export class FullAutoLifecycle {
  private state: State = { kind: 'idle' };
  private watchdog: ReturnType<typeof setInterval> | null = null;

  get running(): boolean {
    return this.state.kind === 'running' || this.state.kind === 'stopping';
  }
  get scheduled(): boolean {
    return 'next' in this.state && this.state.next !== undefined;
  }
  get token(): number | null {
    return this.running && 'token' in this.state ? this.state.token : null;
  }
  owns(token: number | null): boolean {
    return token !== null && this.token === token;
  }

  begin(token: number): boolean {
    if (this.running || this.state.kind === 'disposed') return false;
    this.cancelScheduled();
    this.state = { kind: 'running', token, interrupted: false };
    return true;
  }

  schedule(delayMs: number, run: () => void): void {
    if (this.state.kind === 'disposed') return;
    this.cancelScheduled();
    const next: Schedule = {
      timer: setTimeout(() => this.fire(next), delayMs),
      due: false,
      run,
    };
    if (this.state.kind === 'running' || this.state.kind === 'stopping')
      this.state = { ...this.state, next };
    else this.state = { kind: 'scheduled', next };
  }

  private fire(next: Schedule): void {
    if (!('next' in this.state) || this.state.next !== next) return;
    if (this.running) {
      next.due = true;
      return;
    }
    this.state = { kind: 'idle' };
    next.run();
  }

  cancelScheduled(): void {
    if (!('next' in this.state) || !this.state.next) return;
    clearTimeout(this.state.next.timer);
    if (this.state.kind === 'scheduled') this.state = { kind: 'idle' };
    else this.state = { ...this.state, next: undefined };
  }

  watch(token: number, pollMs: number, check: () => void): void {
    if (!this.owns(token)) return;
    this.clearWatchdog();
    this.watchdog = setInterval(() => {
      if (this.state.kind === 'running' && this.owns(token)) check();
    }, pollMs);
  }

  interrupt(token: number): boolean {
    if (this.state.kind !== 'running' || !this.owns(token)) return false;
    this.clearWatchdog();
    this.state = { ...this.state, kind: 'stopping', interrupted: true };
    return true;
  }

  takeInterruption(token: number): boolean {
    if (
      this.state.kind !== 'stopping' ||
      !this.owns(token) ||
      !this.state.interrupted
    )
      return false;
    this.state = { ...this.state, interrupted: false };
    return true;
  }

  finish(token: number): void {
    if (
      !this.owns(token) ||
      (this.state.kind !== 'running' && this.state.kind !== 'stopping')
    )
      return;
    this.clearWatchdog();
    const next = this.state.next;
    this.state = next ? { kind: 'scheduled', next } : { kind: 'idle' };
    if (next?.due) queueMicrotask(() => this.fire(next));
  }

  clearWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  dispose(): void {
    this.cancelScheduled();
    this.clearWatchdog();
    this.state = { kind: 'disposed' };
  }
}
