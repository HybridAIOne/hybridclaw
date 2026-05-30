const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 90;

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CLEAR_LINE = '\r\x1b[2K';

export interface ProgressIndicator {
  /** Stop the animation and print a success line with a check mark. */
  succeed(message: string): void;
  /** Stop the animation and print a failure line with a cross mark. */
  fail(message: string): void;
  /** Stop the animation and leave no result line behind. */
  clear(): void;
}

/**
 * Decide whether to draw the animated spinner. We only animate on a real TTY so
 * piped output, log files (e.g. the detached gateway backend), and the test
 * runner get plain, readable lines instead of ANSI escape noise.
 */
function isAnimated(stream: NodeJS.WriteStream): boolean {
  if (process.env.HYBRIDCLAW_NO_SPINNER === '1') return false;
  if (process.env.VITEST) return false;
  return stream.isTTY === true;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * Start a single-line progress indicator for a long-running step. On an
 * interactive terminal it animates a spinner with an elapsed-time counter; on
 * non-interactive streams it stays silent until a result line is printed, so
 * logs and test output stay clean.
 */
export function startProgressIndicator(
  message: string,
  stream: NodeJS.WriteStream = process.stdout,
): ProgressIndicator {
  const animated = isAnimated(stream);
  const startedAt = Date.now();
  let frame = 0;
  let timer: NodeJS.Timeout | null = null;
  let finished = false;

  const render = () => {
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    frame += 1;
    const elapsed = formatElapsed(Date.now() - startedAt);
    stream.write(
      `${CLEAR_LINE}${CYAN}${glyph}${RESET} ${message} ${DIM}(${elapsed})${RESET}`,
    );
  };

  if (animated) {
    render();
    timer = setInterval(render, FRAME_INTERVAL_MS);
    // Never let the spinner keep the process alive on its own.
    timer.unref?.();
  }

  const stop = () => {
    if (finished) return false;
    finished = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (animated) stream.write(CLEAR_LINE);
    return true;
  };

  return {
    succeed(result) {
      if (!stop()) return;
      console.log(animated ? `${GREEN}✔${RESET} ${result}` : result);
    },
    fail(result) {
      if (!stop()) return;
      console.warn(animated ? `${RED}✖${RESET} ${result}` : result);
    },
    clear() {
      stop();
    },
  };
}
