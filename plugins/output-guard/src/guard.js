import { resolveOutputGuardProfileSelection } from './config.js';
import { callOutputGuardModel, tryParseClassifierVerdict } from './llm.js';
import { detectRuleViolations, summarizeViolations } from './rules.js';

const CLASSIFIER_SYSTEM_PROMPT = [
  'You are an output guard compliance reviewer.',
  'You receive an assistant response and an output guard brief.',
  "Treat the output guard brief, policy, Do list, Don't list, banned rules, and required phrases as mandatory output requirements.",
  'Return non_compliant when the response does not clearly follow the requested style, tone, phrasing, required content, or avoidance rules.',
  'Reply with a single JSON object on one line: {"verdict":"compliant"|"non_compliant","reasons":[string],"severity":"low"|"medium"|"high"}',
  'Do not include any prose outside the JSON.',
].join(' ');

const REWRITER_SYSTEM_PROMPT = [
  'You are an output guard rewriter.',
  'You receive an assistant response and an output guard brief.',
  'Rewrite the response so it follows the output guard policy while preserving every fact, instruction, citation, list, and code block.',
  'Do not invent new claims, do not omit content, and do not add disclaimers.',
  'Return only the rewritten response text.',
].join(' ');

function buildClassifierPrompt(context, policyBrief, violations) {
  const sections = [`Output guard brief:\n${policyBrief || '(none provided)'}`];
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
  policyBrief,
  violations,
  classifierReasons,
) {
  const sections = [`Output guard brief:\n${policyBrief || '(none provided)'}`];
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
    return `Output guard violations: ${summarizeViolations(violations)}`;
  }
  if (classifierVerdict?.reasons?.length) {
    return `Output guard reviewer flagged: ${classifierVerdict.reasons.join('; ')}`;
  }
  return 'Output guard violations detected.';
}

function ensureNonEmpty(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

export function createOutputGuardGuard({ api, config }) {
  return {
    id: 'output-guard',
    priority: 100,
    async inspect(context) {
      if (!config.enabled) {
        return { action: 'allow' };
      }
      const text = String(context.resultText || '');
      if (text.length === 0 || text.length < config.minLength) {
        return { action: 'allow' };
      }

      const { profile } = resolveOutputGuardProfileSelection(
        config,
        context.channelId,
      );
      const policyBrief = profile.policyBrief;
      const violations = detectRuleViolations(text, profile);
      let classifierVerdict = null;
      try {
        const raw = await callOutputGuardModel({
          client: config.classifier,
          api,
          systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
          userPrompt: buildClassifierPrompt(context, policyBrief, violations),
          fallbackModel: context.model,
        });
        classifierVerdict = tryParseClassifierVerdict(raw);
        if (!classifierVerdict) {
          api.logger.warn(
            { rawSnippet: String(raw || '').slice(0, 200) },
            'output-guard: classifier returned non-parseable verdict; ignoring',
          );
        } else {
          api.logger.debug(
            {
              classifierVerdict,
              violations,
              mode: config.mode,
              channelId: context.channelId,
            },
            'output-guard: classifier evaluated response',
          );
        }
      } catch (error) {
        api.logger.warn({ error }, 'output-guard: classifier call failed');
        if (config.failureMode === 'block') {
          return {
            action: 'block',
            reason: 'Output guard classifier unavailable.',
          };
        }
      }

      const nonCompliant =
        violations.length > 0 || classifierVerdict?.verdict === 'non_compliant';
      if (!nonCompliant) {
        return { action: 'allow' };
      }

      const reason = buildBlockReason(violations, classifierVerdict);
      api.logger.info(
        {
          violations,
          classifierVerdict,
          mode: config.mode,
          channelId: context.channelId,
        },
        'output-guard: response flagged non-compliant',
      );

      if (config.mode === 'flag') {
        return { action: 'warn', reason };
      }
      if (config.mode === 'block') {
        return {
          action: 'block',
          reason,
        };
      }
      // mode === 'rewrite'
      try {
        const rewritten = await callOutputGuardModel({
          client: config.rewriter,
          api,
          systemPrompt: REWRITER_SYSTEM_PROMPT,
          userPrompt: buildRewriterPrompt(
            context,
            policyBrief,
            violations,
            classifierVerdict?.reasons || [],
          ),
          fallbackModel: context.model,
        });
        if (!ensureNonEmpty(rewritten)) {
          throw new Error('Rewriter returned empty text.');
        }
        const remainingViolations = detectRuleViolations(rewritten, profile);
        if (remainingViolations.length > 0) {
          api.logger.warn(
            { remainingViolations },
            'output-guard: rewrite still violated rules; blocking',
          );
          return {
            action: 'block',
            reason: `Rewrite still violated output guard (${summarizeViolations(remainingViolations)}).`,
          };
        }
        return {
          action: 'rewrite',
          text: rewritten.trim(),
          reason,
        };
      } catch (error) {
        api.logger.warn({ error }, 'output-guard: rewriter call failed');
        if (config.failureMode === 'block') {
          return {
            action: 'block',
            reason: 'Output guard rewriter unavailable.',
          };
        }
        return { action: 'allow' };
      }
    },
  };
}

export function createOutputGuardMiddleware({ api, config }) {
  const guard = createOutputGuardGuard({ api, config });

  return {
    id: 'output-guard',
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
          reason: decision.reason || 'Output guard middleware rewrote output.',
        };
      }
      if (decision.action === 'warn') {
        return {
          action: 'warn',
          reason: decision.reason || 'Output guard middleware flagged output.',
        };
      }
      return {
        action: 'block',
        reason: decision.reason,
      };
    },
  };
}
