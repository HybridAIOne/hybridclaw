import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import type { AuxiliaryTask } from '../providers/task-routing.js';
import type { ChatMessage } from '../types/api.js';
import type { Session } from '../types/session.js';

const AUX_TEST_TIMEOUT_MS = 300_000;
const AUX_TEST_DEFAULT_MAX_TOKENS = 256;
export const AUX_COMMAND_USAGE =
  'Usage: `/aux test <task> <prompt> [--max-tokens <n>]`';

const AUX_TEXT_TASKS = [
  'compression',
  'web_extract',
  'session_search',
  'skills_hub',
  'eval_judge',
  'goal_judge',
  'mcp',
  'flush_memories',
  'btw',
  'second_opinion',
  'session_title',
  'cv_narration',
] as const satisfies readonly Exclude<AuxiliaryTask, 'vision'>[];

type AuxTextTask = (typeof AUX_TEXT_TASKS)[number];
type AuxModelUsage = Awaited<ReturnType<typeof callAuxiliaryModel>>['usage'];

export class AuxCommandUsageError extends Error {
  constructor(message = AUX_COMMAND_USAGE) {
    super(message);
    this.name = 'AuxCommandUsageError';
  }
}

function isAuxTextTask(value: string): value is AuxTextTask {
  return (AUX_TEXT_TASKS as readonly string[]).includes(value);
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatAuxTaskList(): string {
  return AUX_TEXT_TASKS.join(', ');
}

function buildAuxTestMessages(
  task: AuxTextTask,
  prompt: string,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        `You are running a HybridClaw auxiliary model smoke test for task "${task}".`,
        'Answer only the user test prompt.',
        'Do not use tools, claim you used tools, or continue any other task.',
        'Keep the response concise.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: ['<aux_test_prompt>', prompt.trim(), '</aux_test_prompt>'].join(
        '\n',
      ),
    },
  ];
}

function parseAuxTestArgs(args: string[]): {
  task: AuxTextTask;
  prompt: string;
  maxTokens: number;
} {
  const maybeSubcommand = (args[0] || '').trim().toLowerCase();
  const taskArg =
    maybeSubcommand === 'test'
      ? (args[1] || '').trim()
      : (args[0] || '').trim();
  const task = taskArg.toLowerCase();
  if (!task) {
    throw new AuxCommandUsageError(
      `${AUX_COMMAND_USAGE}\nAvailable text tasks: ${formatAuxTaskList()}`,
    );
  }
  if (task === 'vision') {
    throw new AuxCommandUsageError(
      'The `vision` auxiliary task requires media input and cannot be triggered with `/aux test`.',
    );
  }
  if (!isAuxTextTask(task)) {
    throw new AuxCommandUsageError(
      `Unknown auxiliary task \`${taskArg}\`. Available text tasks: ${formatAuxTaskList()}`,
    );
  }

  const promptArgs = args.slice(maybeSubcommand === 'test' ? 2 : 1);
  const promptParts: string[] = [];
  let maxTokens = AUX_TEST_DEFAULT_MAX_TOKENS;
  for (let index = 0; index < promptArgs.length; index += 1) {
    const arg = promptArgs[index] || '';
    if (arg === '--max-tokens') {
      const value = promptArgs[index + 1] || '';
      const parsed = parsePositiveInt(value);
      if (!parsed) {
        throw new AuxCommandUsageError(
          'Expected a positive integer after `--max-tokens`.',
        );
      }
      maxTokens = parsed;
      index += 1;
      continue;
    }
    promptParts.push(arg);
  }

  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    throw new AuxCommandUsageError(AUX_COMMAND_USAGE);
  }

  return { task, prompt, maxTokens };
}

function formatUsage(usage: AuxModelUsage): string | null {
  if (!usage) return null;
  const parts = [
    usage.inputTokens == null ? null : `${usage.inputTokens} input`,
    usage.outputTokens == null ? null : `${usage.outputTokens} output`,
    usage.totalTokens == null ? null : `${usage.totalTokens} total`,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `Usage: ${parts.join(' / ')}` : null;
}

function formatAuxResultModel(params: {
  provider: Awaited<ReturnType<typeof callAuxiliaryModel>>['provider'];
  model: string;
}): string {
  return params.provider === 'hybridai'
    ? formatModelForDisplay(params.model)
    : params.model;
}

export async function runAuxCommand(
  session: Session,
  args: string[],
): Promise<string> {
  const subcommand = (args[0] || '').trim().toLowerCase();
  if (subcommand === 'list') {
    return `Text tasks: ${formatAuxTaskList()}`;
  }

  const parsed = parseAuxTestArgs(args);
  const resolved = resolveAgentForRequest({ session });
  const result = await callAuxiliaryModel({
    task: parsed.task,
    messages: buildAuxTestMessages(parsed.task, parsed.prompt),
    fallbackModel: resolved.model,
    fallbackChatbotId: resolved.chatbotId,
    agentId: resolved.agentId,
    tools: [],
    maxTokens: parsed.maxTokens,
    timeoutMs: AUX_TEST_TIMEOUT_MS,
  });

  return [
    `Task: ${parsed.task}`,
    `Provider: ${result.provider}`,
    `Model: ${formatAuxResultModel(result)}`,
    formatUsage(result.usage),
    '',
    result.content,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
