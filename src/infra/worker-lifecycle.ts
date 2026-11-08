/**
 * Worker ownership and request leases survive callbacks, never process replacement.
 * Terminal workers cannot become idle or be claimed again. Unlike the warm pool,
 * this owns transitions, not capacity policy, spawning, IPC or durable session state.
 */
import type { ActivityTracker } from './ipc.js';

type WorkerOwner = { kind: 'spare' } | { kind: 'session'; sessionId: string };
type Execution = { requestId: string; activity: ActivityTracker };
type WorkerState =
  | { kind: 'starting' | 'idle' }
  | { kind: 'executing'; execution: Execution }
  | { kind: 'stopping'; execution?: Execution }
  | { kind: 'exited'; error: string; execution?: Execution };

export class WorkerLifecycle {
  private state: WorkerState = { kind: 'starting' };
  private ownerValue: WorkerOwner;
  private readyAt: number | null = null;

  constructor(sessionId: string | null) {
    this.ownerValue =
      sessionId === null ? { kind: 'spare' } : { kind: 'session', sessionId };
  }

  get owner(): Readonly<WorkerOwner> {
    return this.ownerValue;
  }
  get phase(): WorkerState['kind'] {
    return this.state.kind;
  }
  get isSpare(): boolean {
    return this.ownerValue.kind === 'spare';
  }
  get readyForInputAt(): number | null {
    return this.readyAt;
  }
  get activity(): ActivityTracker | undefined {
    return 'execution' in this.state
      ? this.state.execution?.activity
      : undefined;
  }
  get terminalError(): string | null {
    return this.state.kind === 'exited' ? this.state.error : null;
  }
  get reusable(): boolean {
    return this.state.kind === 'starting' || this.state.kind === 'idle';
  }

  claim(sessionId: string): void {
    if (!this.isSpare || !this.reusable)
      throw new Error('Worker is not a claimable spare.');
    this.ownerValue = { kind: 'session', sessionId };
  }

  ready(now: number): void {
    if (this.state.kind === 'stopping' || this.state.kind === 'exited') return;
    this.readyAt = now;
    if (this.state.kind === 'starting') this.state = { kind: 'idle' };
    this.activity?.notify();
  }

  begin(requestId: string, activity: ActivityTracker): void {
    if (this.isSpare || !this.reusable)
      throw new Error('Worker cannot accept this request.');
    this.state = { kind: 'executing', execution: { requestId, activity } };
  }

  finish(requestId: string): boolean {
    const execution =
      'execution' in this.state ? this.state.execution : undefined;
    if (execution?.requestId !== requestId) return false;
    switch (this.state.kind) {
      case 'executing':
        this.state = { kind: this.readyAt === null ? 'starting' : 'idle' };
        break;
      case 'stopping':
        this.state = { kind: 'stopping' };
        break;
      case 'exited':
        this.state = { kind: 'exited', error: this.state.error };
        break;
    }
    return true;
  }

  stop(): boolean {
    if (this.state.kind === 'stopping' || this.state.kind === 'exited')
      return false;
    const execution =
      this.state.kind === 'executing' ? this.state.execution : undefined;
    this.state = { kind: 'stopping', execution };
    return true;
  }

  exit(error: string): void {
    if (this.state.kind === 'exited') return;
    const execution =
      'execution' in this.state ? this.state.execution : undefined;
    this.state = { kind: 'exited', error, execution };
  }
}
