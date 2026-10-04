/**
 * Nine synthetic messages exercise quick reactions and conversational replies
 * independently. Uses configured credentials; creates no sessions or agent work.
 * Run with tsx scripts/benchmark-chat-reactions.ts --reaction-model <id> --runs 3.
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { readSingleEmoji } from '../container/shared/reactions.js';
import { CHAT_REPLY_LINES } from '../src/agent/mobile-prompt.js';
import { REACTION_STYLE_LINES } from '../src/agent/prompt-hooks.js';
import { getRuntimeConfig } from '../src/config/runtime-config.js';
import { CHAT_REACTION_PROMPT } from '../src/gateway/early-reaction.js';
import { callAuxiliaryModel } from '../src/providers/auxiliary.js';
import { resolveModelProvider } from '../src/providers/factory.js';

const { values } = parseArgs({
  options: {
    'reaction-model': { type: 'string' },
    'reply-model': { type: 'string' },
    runs: { type: 'string', default: '3' },
    output: { type: 'string' },
  },
});
const config = getRuntimeConfig();
const reactionModel =
  values['reaction-model'] || config.auxiliaryModels.chat_reaction.model;
const replyModel = values['reply-model'] || config.hybridai.defaultModel;
if (!reactionModel)
  throw new Error(
    'Set --reaction-model or auxiliaryModels.chat_reaction.model.',
  );
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 10)
  throw new Error('--runs must be between 1 and 10.');
const cases = [
  ['Hi!', true],
  ['Awesome!', false],
  ['How are you?', true],
  ["How's the weather?", true],
  ['You are great!', false],
  ['Thanks!', false],
  ["What's the news?", true],
  ['Can you do ...?', true],
  ['Please research ...?', true],
] as const;
const results: Array<{
  prompt: string;
  run: number;
  reaction: string | null;
  reactionMs: number;
  reply: string;
  replyMs: number;
  passed: boolean;
}> = [];
for (let run = 1; run <= runs; run++) {
  for (const [prompt, needsText] of cases) {
    const reactionStarted = performance.now();
    const reactionResult = await callAuxiliaryModel({
      task: 'chat_reaction',
      model: reactionModel,
      provider: resolveModelProvider(reactionModel),
      allowFallback: false,
      maxTokens: 16,
      timeoutMs: 5000,
      temperature: 0,
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      messages: [
        { role: 'system', content: CHAT_REACTION_PROMPT },
        { role: 'user', content: prompt },
      ],
    });
    const reactionMs = Math.round(performance.now() - reactionStarted);
    const reaction = readSingleEmoji(reactionResult.content) || null;
    const replyStarted = performance.now();
    const replyResult = await callAuxiliaryModel({
      task: 'eval_judge',
      model: replyModel,
      provider: resolveModelProvider(replyModel),
      fallbackChatbotId: config.hybridai.defaultChatbotId,
      fallbackEnableRag: false,
      allowFallback: false,
      maxTokens: 250,
      timeoutMs: 30000,
      messages: [
        {
          role: 'system',
          content: [
            "Your name is Hy. Answer in the user's language.",
            ...CHAT_REPLY_LINES,
            ...REACTION_STYLE_LINES,
          ].join('\n'),
        },
        { role: 'user', content: prompt },
      ],
    });
    const replyMs = Math.round(performance.now() - replyStarted);
    const reply = replyResult.content.trim();
    const replyEmoji = readSingleEmoji(reply);
    const passed =
      Boolean(reaction) &&
      (needsText ? !replyEmoji && /\p{L}/u.test(reply) : Boolean(replyEmoji));
    const result = {
      prompt,
      run,
      reaction,
      reactionMs,
      reply,
      replyMs,
      passed,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    if (values.output)
      fs.writeFileSync(
        values.output,
        JSON.stringify({ reactionModel, replyModel, results }, null, 2),
      );
  }
}
const latency = results
  .map((result) => result.reactionMs)
  .sort((a, b) => a - b);
const summary = {
  reactionModel,
  replyModel,
  cases: results.length,
  passed: results.filter((result) => result.passed).length,
  reactionMedianMs: latency[Math.floor(latency.length / 2)],
  reactionP95Ms: latency[Math.ceil(latency.length * 0.95) - 1],
  reactionWithin750ms: results.filter((result) => result.reactionMs <= 750)
    .length,
};
console.log(JSON.stringify(summary));
if (values.output)
  fs.writeFileSync(
    values.output,
    JSON.stringify({ ...summary, results }, null, 2),
  );
process.exitCode = summary.passed === summary.cases ? 0 : 1;
