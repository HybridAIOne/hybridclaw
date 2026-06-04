const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 90;

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CLEAR_LINE = '\r\x1b[2K';

export interface ProgressIndicator {
  succeed(message: string): void;
  fail(message: string): void;
  clear(): void;
}

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
    timer.unref?.();
  } else {
    console.log(message);
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
