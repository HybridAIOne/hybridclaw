import { buildVoiceBrief } from './config.js';
import { callBrandVoiceModel, tryParseClassifierVerdict } from './llm.js';
import { detectRuleViolations, summarizeViolations } from './rules.js';

const CLASSIFIER_SYSTEM_PROMPT = [
  'You are a brand-voice compliance reviewer.',
  'You receive an assistant response and a brand voice brief.',
  'Decide whether the response is on-brand or off-brand.',
  'Reply with a single JSON object on one line: {"verdict":"on_brand"|"off_brand","reasons":[string],"severity":"low"|"medium"|"high"}',
  'Do not include any prose outside the JSON.',
].join(' ');

const REWRITER_SYSTEM_PROMPT = [
  'You are a brand-voice rewriter.',
  'You receive an assistant response and a brand voice brief.',
  'Rewrite the response so it is on-brand while preserving every fact, instruction, citation, list, and code block.',
  'Do not invent new claims, do not omit content, and do not add disclaimers.',
  'Return only the rewritten response text.',
].join(' ');

function buildClassifierPrompt(context, voiceBrief, violations) {
  const sections = [`Brand voice brief:\n${voiceBrief || '(none provided)'}`];
  if (violations.length > 0) {
    sections.push(
      `Detected rule violations: ${summarizeViolations(violations)}`,
    );
  }
  if (context.userContent) {
    sections.push(`User message:\n${context.userContent}`);
  }
  sections.push(`Assistant response:\n${context.resultText}`);
  sections.push('Reply with the JSON verdict object only.');
  return sections.join('\n\n');
}

function buildRewriterPrompt(
  context,
  voiceBrief,
  violations,
  classifierReasons,
) {
  const sections = [`Brand voice brief:\n${voiceBrief || '(none provided)'}`];
  if (violations.length > 0) {
    sections.push(`Rule violations to fix: ${summarizeViolations(violations)}`);
  }
  if (classifierReasons.length > 0) {
    sections.push(`Reviewer notes:\n- ${classifierReasons.join('\n- ')}`);
  }
  if (context.userContent) {
    sections.push(`User message:\n${context.userContent}`);
  }
  sections.push(`Original response:\n${context.resultText}`);
  sections.push('Return only the rewritten response.');
  return sections.join('\n\n');
}

function buildBlockReason(violations, classifierVerdict) {
  if (violations.length > 0) {
    return `Brand-voice violations: ${summarizeViolations(violations)}`;
  }
  if (classifierVerdict?.reasons?.length) {
    return `Brand-voice reviewer flagged: ${classifierVerdict.reasons.join('; ')}`;
  }
  return 'Brand-voice violations detected.';
}

function ensureNonEmpty(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

export function createBrandVoiceGuard({ api, config }) {
  const voiceBrief = buildVoiceBrief(config);

  return {
    id: 'brand-voice',
    priority: 100,
    async inspect(context) {
      if (!config.enabled) {
        return { action: 'allow' };
      }
      const text = String(context.resultText || '');
      if (text.length === 0 || text.length < config.minLength) {
        return { action: 'allow' };
      }

      const violations = detectRuleViolations(text, config);
      let classifierVerdict = null;
      if (config.classifier.provider !== 'none') {
        try {
          const raw = await callBrandVoiceModel({
            client: config.classifier,
            api,
            systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
            userPrompt: buildClassifierPrompt(context, voiceBrief, violations),
          });
          classifierVerdict = tryParseClassifierVerdict(raw);
          if (!classifierVerdict) {
            api.logger.warn(
              { rawSnippet: String(raw || '').slice(0, 200) },
              'brand-voice: classifier returned non-parseable verdict; ignoring',
            );
          }
        } catch (error) {
          api.logger.warn({ error }, 'brand-voice: classifier call failed');
          if (config.failureMode === 'block') {
            return {
              action: 'block',
              reason: 'Brand-voice classifier unavailable.',
              replacement: config.blockMessage,
            };
          }
        }
      }

      const offBrand =
        violations.length > 0 || classifierVerdict?.verdict === 'off_brand';
      if (!offBrand) {
        return { action: 'allow' };
      }

      const reason = buildBlockReason(violations, classifierVerdict);
      api.logger.info(
        {
          violations,
          classifierVerdict,
          mode: config.mode,
        },
        'brand-voice: response flagged off-brand',
      );

      if (config.mode === 'flag') {
        return { action: 'allow' };
      }
      if (config.mode === 'block') {
        return {
          action: 'block',
          reason,
          replacement: config.blockMessage,
        };
      }
      // mode === 'rewrite'
      if (config.rewriter.provider === 'none') {
        api.logger.warn(
          {},
          'brand-voice: rewrite mode but rewriter.provider="none"; blocking instead',
        );
        return {
          action: 'block',
          reason,
          replacement: config.blockMessage,
        };
      }
      try {
        const rewritten = await callBrandVoiceModel({
          client: config.rewriter,
          api,
          systemPrompt: REWRITER_SYSTEM_PROMPT,
          userPrompt: buildRewriterPrompt(
            context,
            voiceBrief,
            violations,
            classifierVerdict?.reasons || [],
          ),
        });
        if (!ensureNonEmpty(rewritten)) {
          throw new Error('Rewriter returned empty text.');
        }
        const remainingViolations = detectRuleViolations(rewritten, config);
        if (remainingViolations.length > 0) {
          api.logger.warn(
            { remainingViolations },
            'brand-voice: rewrite still violated rules; blocking',
          );
          return {
            action: 'block',
            reason: `Rewrite still violated brand voice (${summarizeViolations(remainingViolations)}).`,
            replacement: config.blockMessage,
          };
        }
        return {
          action: 'rewrite',
          text: rewritten.trim(),
          reason,
        };
      } catch (error) {
        api.logger.warn({ error }, 'brand-voice: rewriter call failed');
        if (config.failureMode === 'block') {
          return {
            action: 'block',
            reason: 'Brand-voice rewriter unavailable.',
            replacement: config.blockMessage,
          };
        }
        return { action: 'allow' };
      }
    },
  };
}

export function createBrandVoiceMiddleware({ api, config }) {
  const guard = createBrandVoiceGuard({ api, config });

  return {
    id: 'brand-voice',
    priority: guard.priority,
    async post_receive(context) {
      const decision = await guard.inspect({
        sessionId: context.sessionId,
        userId: context.userId,
        agentId: context.agentId,
        channelId: context.channelId,
        model: context.model,
        userContent: context.userContent,
        resultText: context.resultText || '',
      });
      if (!decision || decision.action === 'allow') {
        return { action: 'allow' };
      }
      if (decision.action === 'rewrite') {
        return {
          action: 'transform',
          payload: decision.text,
          reason: decision.reason || 'Brand-voice middleware rewrote output.',
        };
      }
      return {
        action: 'block',
        reason: decision.reason,
        ...(decision.replacement ? { payload: decision.replacement } : {}),
      };
    },
  };
}
