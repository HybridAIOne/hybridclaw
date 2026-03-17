import type { WorkflowEvent } from './event-bus.js';

function readString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

export function interpolateWorkflowTemplate(
  template: string,
  values: Record<string, string | null | undefined>,
): string {
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, token: string) => {
    const key = token.trim();
    if (!key) return '';
    return readString(values[key]);
  });
}

export function buildWorkflowInterpolationContext(params: {
  event?: WorkflowEvent;
  workflowContext?: Record<string, string>;
  stepResults?: Array<{ index: number; id: string; result: string }>;
  extractedValues?: Record<string, string>;
  fallbackTimestamp?: string;
}): Record<string, string> {
  const values: Record<string, string> = {
    ...(params.workflowContext || {}),
    ...(params.extractedValues || {}),
  };
  const event = params.event;
  values['trigger.kind'] = readString(event?.kind);
  values['trigger.sourceChannel'] = readString(event?.sourceChannel);
  values['trigger.channelId'] = readString(event?.channelId);
  values['trigger.sender'] =
    readString(event?.senderAddress) || readString(event?.senderId);
  values['trigger.senderId'] = readString(event?.senderId);
  values['trigger.senderAddress'] = readString(event?.senderAddress);
  values['trigger.content'] = readString(event?.content);
  values['trigger.subject'] = readString(event?.subject);
  values['trigger.reactionEmoji'] = readString(event?.reactionEmoji);
  values['trigger.timestamp'] =
    event && Number.isFinite(event.timestamp)
      ? new Date(event.timestamp).toISOString()
      : readString(params.fallbackTimestamp);

  for (const stepResult of params.stepResults || []) {
    values[`step_${stepResult.index}.result`] = stepResult.result;
    values[`step.${stepResult.id}.result`] = stepResult.result;
  }

  return values;
}
