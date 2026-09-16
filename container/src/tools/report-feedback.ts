/**
 * `report_feedback` lets the model queue a bug/idea report about HybridClaw
 * itself. The draft is stored by the gateway and never leaves the deployment
 * until an operator reviews it with `/feedback` — this tool only drafts.
 */
import {
  FEEDBACK_DRAFT_FAILURE_MODES,
  FEEDBACK_DRAFT_TASK_CATEGORIES,
  FEEDBACK_DRAFT_TRIGGERS,
  FEEDBACK_DRAFT_TYPES,
  REPORT_FEEDBACK_TOOL_NAME,
  validateFeedbackDraftInput,
} from '../../shared/feedback-drafts.js';
import type { ToolDefinition } from '../types.js';

export { REPORT_FEEDBACK_TOOL_NAME };

export const REPORT_FEEDBACK_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: REPORT_FEEDBACK_TOOL_NAME,
    description: [
      'Draft feedback about HybridClaw itself (the agent runtime, its tools, channels, or your own behaviour) at a high-signal moment:',
      '- a reproducible tool or runtime failure was just resolved or abandoned',
      '- the user clearly expressed frustration with HybridClaw or with how you handled the task',
      '- a missing capability blocked a reasonable request',
      '- you notice, or the user points out, that your own behaviour went wrong (a confident answer you retracted, stopping short, declining a reasonable request, wrong tone, scope creep, ignored instructions)',
      'The draft is QUEUED LOCALLY on the gateway. It is never sent without an operator explicitly approving it, so calling this tool does not interrupt the conversation.',
      'Write `details` as short labeled bullets in this exact order, one to three lines each, facts only: **What happened:** observed vs expected, exact error text if short. **What the user said:** the user\'s own words, quoted, or "User didn\'t comment; observed by the model." — never paraphrase sentiment into a stronger claim. **Repro:** the minimal steps or shape that reproduces it. **Evidence:** identifiers a reader can chase (tool names, file paths, timestamps, ids). Add a final **Cause:** bullet only for a root cause you verified.',
      'Do not include secrets, credentials, message contents beyond the quoted user words, or personal data. Refer to people by role, never by name, email, or handle. Draft at most one report per distinct issue; never re-draft the same issue in a session. Do not draft feedback about the user or their business — only about HybridClaw.',
      'After a successful call, add exactly one short closing line to your reply telling the user a feedback draft exists and that `/feedback` reviews it. Do not repeat the draft contents.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [...FEEDBACK_DRAFT_TYPES],
          description: 'What kind of feedback this is.',
        },
        title: {
          type: 'string',
          description: 'Short, specific one-line summary of the issue.',
        },
        details: {
          type: 'string',
          description:
            'Labeled bullets in order: **What happened:**, **What the user said:**, **Repro:**, **Evidence:** (omit if none), optional **Cause:**.',
        },
        area: {
          type: 'string',
          description:
            'Optional short tag naming the part of HybridClaw this is about (e.g. "bash tool", "msteams channel", "memory", "approvals").',
        },
        trigger: {
          type: 'string',
          enum: [...FEEDBACK_DRAFT_TRIGGERS],
          description:
            'What prompted the draft. Defaults to model_judgment; use operator_request when the user explicitly asked you to file feedback.',
        },
        failure_mode: {
          type: 'string',
          enum: [...FEEDBACK_DRAFT_FAILURE_MODES],
          description:
            'Only when the report is about your own behaviour, the closest failure mode. Omit for a pure runtime/tool bug.',
        },
        task_category: {
          type: 'string',
          enum: [...FEEDBACK_DRAFT_TASK_CATEGORIES],
          description: 'What kind of task the conversation was doing.',
        },
      },
      required: ['type', 'title', 'details'],
    },
  },
};

export interface ReportFeedbackGatewayContext {
  gatewayBaseUrl: string;
  gatewayApiToken: string;
  sessionId: string;
  channelId: string;
  agentId: string;
  model: string;
  provider: string;
}

export interface ReportFeedbackOutcome {
  ok: boolean;
  output: string;
}

function readErrorDetail(rawText: string, status: number): string {
  try {
    const parsed = JSON.parse(rawText) as { error?: unknown };
    if (typeof parsed?.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // Fall through to the raw body.
  }
  return rawText.trim() || `HTTP ${status}`;
}

export async function runReportFeedback(
  rawArgs: Record<string, unknown>,
  context: ReportFeedbackGatewayContext,
): Promise<ReportFeedbackOutcome> {
  const validated = validateFeedbackDraftInput(rawArgs);
  if (!validated.ok) {
    return { ok: false, output: `Error: ${validated.error}` };
  }

  const base = context.gatewayBaseUrl.replace(/\/+$/, '');
  if (!base) {
    return {
      ok: false,
      output:
        'Error: report_feedback is unavailable because gatewayBaseUrl is not configured.',
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (context.gatewayApiToken) {
    headers.Authorization = `Bearer ${context.gatewayApiToken}`;
  }

  let response: Response;
  try {
    response = await fetch(`${base}/api/feedback/draft`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: context.sessionId,
        channelId: context.channelId,
        agentId: context.agentId,
        model: context.model,
        provider: context.provider,
        draft: validated.value,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      output: `Error: feedback draft request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const rawText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      output: `Error: feedback draft was not queued (HTTP ${response.status}): ${readErrorDetail(rawText, response.status)}`,
    };
  }

  let draftId = '';
  let deduplicated = false;
  try {
    const parsed = JSON.parse(rawText) as {
      draft?: { id?: unknown };
      deduplicated?: unknown;
    };
    draftId = typeof parsed?.draft?.id === 'string' ? parsed.draft.id : '';
    deduplicated = parsed?.deduplicated === true;
  } catch {
    draftId = '';
  }
  if (!draftId) {
    return {
      ok: false,
      output: 'Error: gateway did not return a feedback draft id.',
    };
  }

  return {
    ok: true,
    output: JSON.stringify(
      {
        success: true,
        draftId,
        deduplicated,
        status: 'queued',
        message: deduplicated
          ? `A queued draft with this title already exists (${draftId}); nothing new was recorded.`
          : `Feedback draft ${draftId} queued locally. It will not be sent unless an operator approves it with /feedback send ${draftId}.`,
      },
      null,
      2,
    ),
  };
}
