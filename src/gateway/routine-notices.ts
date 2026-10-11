/**
 * Tells the user that a routine failed or skipped due times, so nobody has to
 * look. The notice goes where the routine's replies go: a web routine's to its
 * agent's main chat, where it is stored as the agent's message and rings the
 * owner's phones like a scheduled reply (`web-scheduled-delivery.ts`); any
 * other routine's to its channel. Notices that arrive together, such as after
 * a restart, become one message per chat.
 *
 * NOT the run history: `task-runs.ts` keeps it and decides when a notice is
 * due. The apps' hidden data chats never get one; their routines answer JSON.
 */
import { logger } from '../logger.js';
import { isAppDataChat } from '../memory/agent-main-session.js';
import { memoryService } from '../memory/memory-service.js';
import type { RoutineProblem } from '../scheduler/task-runs.js';
import type { ScheduledTask } from '../types/scheduler.js';
import { deliverProactiveMessage } from './proactive-dispatch.js';
import {
  deliverWebScheduledMessage,
  mainChatForWebTask,
} from './web-scheduled-delivery.js';

const NAME_MAX_LENGTH = 60;

interface Pending {
  task: ScheduledTask;
  problem: RoutineProblem;
}

let pending: Pending[] = [];
let flushing: ReturnType<typeof setTimeout> | null = null;

export function queueRoutineNotice(
  task: ScheduledTask,
  problem: RoutineProblem,
): void {
  pending.push({ task, problem });
  flushing ??= setTimeout(flushRoutineNotices, 0);
}

type Target = { web: string } | { channel: string };

function targetOf(task: ScheduledTask): Target | null {
  if (task.channel_id !== 'web')
    return task.channel_id ? { channel: task.channel_id } : null;
  const origin = memoryService.getSessionById(task.session_id);
  if (!origin || isAppDataChat(origin.session_key)) return null;
  return { web: mainChatForWebTask(task.session_id)?.id ?? origin.id };
}

/**
 * How the routine is named: its title, else the first line of its
 * instruction without the bracketed tags apps and tools put in front.
 */
export function routineName(task: ScheduledTask): string {
  const firstLine = task.prompt.split('\n')[0] ?? '';
  const name =
    task.title?.trim() ||
    firstLine.replace(/^(?:\s*\[[^\]\n]*\])+/, '').trim() ||
    `#${task.id}`;
  return name.length > NAME_MAX_LENGTH
    ? `${name.slice(0, NAME_MAX_LENGTH - 1)}…`
    : name;
}

function when(ms: number, task: ScheduledTask): string {
  return new Date(ms).toLocaleString('en-US', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: task.tz?.trim() || 'UTC',
    timeZoneName: 'short',
  });
}

/** One routine's problem, as a sentence that names it. */
export function describeRoutineProblem(
  task: ScheduledTask,
  problem: RoutineProblem,
): string {
  const name = `“${routineName(task)}”`;
  if (problem.kind === 'missed') {
    const last = problem.dueTimes[problem.dueTimes.length - 1] ?? Date.now();
    return problem.dueTimes.length === 1
      ? `${name} didn't run at ${when(last, task)}.`
      : `${name} missed ${problem.dueTimes.length} runs, the last one due ${when(last, task)}.`;
  }
  const paused = problem.pausedAfter
    ? ` I paused it after ${problem.pausedAfter} failed runs in a row; resume it when it should run again.`
    : '';
  return `${name} failed (due ${when(problem.dueAt, task)}): ${problem.error.replace(/[.\s]+$/, '')}.${paused}`;
}

export function flushRoutineNotices(): void {
  if (flushing) clearTimeout(flushing);
  flushing = null;
  const batch = pending;
  pending = [];
  const byTarget = new Map<string, { target: Target; items: Pending[] }>();
  for (const item of batch) {
    let target: Target | null;
    try {
      target = targetOf(item.task);
    } catch (error) {
      logger.warn({ error, taskId: item.task.id }, 'Routine notice skipped');
      continue;
    }
    if (!target) continue;
    const key = JSON.stringify(target);
    const entry = byTarget.get(key) ?? { target, items: [] };
    entry.items.push(item);
    byTarget.set(key, entry);
  }
  for (const { target, items } of byTarget.values()) {
    const text =
      items.length === 1
        ? `Your routine ${describeRoutineProblem(items[0].task, items[0].problem)}`
        : `Some routines didn't run as planned:\n${items
            .map(
              (item) => `- ${describeRoutineProblem(item.task, item.problem)}`,
            )
            .join('\n')}`;
    const source =
      items.length === 1
        ? `schedule-notice:${items[0].task.id}`
        : 'schedule-notice';
    try {
      if ('web' in target) deliverWebScheduledMessage(target.web, text, source);
      else
        void deliverProactiveMessage(target.channel, text, source).catch(
          (error) => logger.warn({ error }, 'Routine notice not delivered'),
        );
    } catch (error) {
      logger.warn({ error }, 'Routine notice not delivered');
    }
  }
}
