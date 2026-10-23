/**
 * Daily managed routines retain a local clock slot across DST changes.
 * Cron parsing chooses calendar days; gaps move to the first valid minute.
 * This is not the general cron engine and accepts the command's daily shape only.
 */
import { CronExpressionParser } from 'cron-parser';
import type { ScheduledTask } from '../types/scheduler.js';
export function routineDue(
  task: ScheduledTask,
  now: number,
  direction: 'next' | 'previous',
): number {
  const [minute, hour] = task.cron_expr.split(' ').map(Number);
  const wanted = hour * 60 + minute;
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: task.tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = (at: number) => {
    const p = Object.fromEntries(
      clock.formatToParts(at).map((part) => [part.type, part.value]),
    );
    return {
      day: `${p.year}-${p.month}-${p.day}`,
      time: Number(p.hour) * 60 + Number(p.minute),
    };
  };
  const cron = CronExpressionParser.parse(task.cron_expr, {
    currentDate: new Date(now - 7 * 86_400_000),
    tz: task.tz,
  });
  let previous = 0;
  for (let i = 0; i < 12; i++) {
    let due = cron.next().getTime();
    const local = parts(due);
    if (local.time > wanted) {
      while (true) {
        const before = parts(due - 60_000);
        if (before.day !== local.day || before.time < wanted) break;
        due -= 60_000;
      }
    }
    if (due > now) return direction === 'next' ? due : previous;
    previous = due;
  }
  throw new Error('No daily routine occurrence found.');
}
