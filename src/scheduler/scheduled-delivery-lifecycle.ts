/**
 * One scheduled result crosses execution and delivery exactly once per attempt.
 * A restored result bypasses execution; transport acceptance stays distinct from
 * execution success. Unlike routine-editions, this holds no durable records.
 */
import type { ProactiveDeliveryOutcome } from '../channels/channel-descriptor.js';
import type { ProactiveMessagePayload } from '../gateway/fullauto-runtime.js';

type DeliveryStatus = Exclude<ProactiveDeliveryOutcome['status'], 'failed'>;
type ExecutionOutcome = 'completed' | 'reused';
type Outcome =
  | { execution: ExecutionOutcome; delivery: DeliveryStatus }
  | { execution: 'skipped'; delivery: 'none' };
type State =
  | { kind: 'executing' }
  | {
      kind: 'prepared';
      result: ProactiveMessagePayload;
      execution: ExecutionOutcome;
    }
  | { kind: 'delivering'; execution: ExecutionOutcome }
  | { kind: 'settled'; outcome: Outcome };

export class ScheduledDeliveryLifecycle {
  private state: State;

  constructor(saved: ProactiveMessagePayload | null) {
    this.state = saved
      ? { kind: 'prepared', result: saved, execution: 'reused' }
      : { kind: 'executing' };
  }

  get failureStage(): 'execution' | 'delivery' {
    return this.state.kind === 'executing' ? 'execution' : 'delivery';
  }

  prepare(result: ProactiveMessagePayload): void {
    if (this.state.kind !== 'executing')
      throw new Error('Scheduled run already has a result.');
    this.state = { kind: 'prepared', result, execution: 'completed' };
  }

  beginDelivery(): ProactiveMessagePayload {
    if (this.state.kind !== 'prepared')
      throw new Error('Scheduled result is not ready for delivery.');
    const { result, execution } = this.state;
    this.state = { kind: 'delivering', execution };
    return result;
  }

  settle(delivery: DeliveryStatus): void {
    if (this.state.kind !== 'delivering')
      throw new Error('Scheduled delivery is not in progress.');
    this.state = {
      kind: 'settled',
      outcome: { execution: this.state.execution, delivery },
    };
  }

  finish(): Outcome {
    // Silent turns and deferred approvals can return without a deliverable result.
    if (this.state.kind === 'executing')
      this.state = {
        kind: 'settled',
        outcome: { execution: 'skipped', delivery: 'none' },
      };
    if (this.state.kind !== 'settled')
      throw new Error('Scheduled delivery did not settle.');
    return this.state.outcome;
  }
}
