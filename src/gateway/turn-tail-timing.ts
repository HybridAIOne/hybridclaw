/**
 * Times the work a chat turn does after its last streamed text, until the
 * gateway hands back the result. Clients only treat a turn as finished once
 * the result arrives, so every millisecond here is felt as a reply that is on
 * screen but not yet done.
 */
import { logger } from '../logger.js';

/** Tails at least this long are logged at info level, shorter ones at debug. */
export const SLOW_TURN_TAIL_MS = 300;

export class TurnTailTimer {
  private lastTextDeltaAt: number | null = null;
  private previousAt: number | null = null;
  private readonly phases: Record<string, number> = {};

  noteTextDelta(now = Date.now()): void {
    this.lastTextDeltaAt = now;
  }

  /**
   * Records the time since the previous phase ended. The first phase is
   * measured from the last streamed text, or opens the timer when nothing was
   * streamed.
   */
  mark(phase: string, now = Date.now()): void {
    const since = this.previousAt ?? this.lastTextDeltaAt;
    if (since !== null) this.phases[phase] = Math.max(0, now - since);
    this.previousAt = now;
  }

  summary(now = Date.now()): {
    lastTextToNowMs: number | null;
    phasesMs: Record<string, number>;
  } {
    return {
      lastTextToNowMs:
        this.lastTextDeltaAt === null
          ? null
          : Math.max(0, now - this.lastTextDeltaAt),
      phasesMs: { ...this.phases },
    };
  }

  log(meta: Record<string, unknown>, message: string, now = Date.now()): void {
    const summary = this.summary(now);
    const fields = { ...meta, ...summary };
    if (
      summary.lastTextToNowMs !== null &&
      summary.lastTextToNowMs >= SLOW_TURN_TAIL_MS
    ) {
      logger.info(fields, message);
    } else {
      logger.debug(fields, message);
    }
  }
}
