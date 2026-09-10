let inFlightTurns = 0;
let shuttingDown = false;

export function beginInFlightTurn(): () => void {
  inFlightTurns += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightTurns -= 1;
  };
}

export async function trackInFlightTurn<T>(run: () => Promise<T>): Promise<T> {
  const release = beginInFlightTurn();
  try {
    return await run();
  } finally {
    release();
  }
}

export function withInFlightTurn<A extends unknown[], T>(
  handler: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return (...args: A) => trackInFlightTurn(() => handler(...args));
}

export function getInFlightTurnCount(): number {
  return inFlightTurns;
}

export function markGatewayShuttingDown(): void {
  shuttingDown = true;
}

export function isGatewayShuttingDown(): boolean {
  return shuttingDown;
}

export function resetInFlightTurnsForTests(): void {
  inFlightTurns = 0;
  shuttingDown = false;
}
