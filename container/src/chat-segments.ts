import { parseRalphChoice, stripRalphChoiceTags } from './ralph.js';
import type {
  ChatMessageContent,
  OutputPresentationMetadata,
} from './types.js';

export type AssistantChatSegmentKind = 'draft' | 'final' | 'tool_request';

export interface AssistantChatSegment {
  kind: AssistantChatSegmentKind;
  ralphChoice: 'CONTINUE' | 'STOP' | null;
  text: string | null;
}

export function classifyAssistantChatSegment(params: {
  content: ChatMessageContent;
  hasToolCalls: boolean;
  ralphEnabled: boolean;
}): AssistantChatSegment {
  const ralphChoice = parseRalphChoice(params.content);
  const text = stripRalphChoiceTags(params.content);

  if (params.hasToolCalls) {
    return { kind: 'tool_request', ralphChoice, text };
  }

  if (!params.ralphEnabled || ralphChoice === 'STOP') {
    return { kind: 'final', ralphChoice, text };
  }

  return { kind: 'draft', ralphChoice, text };
}

export function outputPresentationForAssistantSegment(
  segment: AssistantChatSegment,
): OutputPresentationMetadata {
  if (segment.kind === 'final') {
    return finalOutputPresentation(segment.text);
  }
  return {
    segmentKind: segment.kind,
    visible: false,
    displaySurface: 'none',
  };
}

export function finalOutputPresentation(
  text: string | null,
): OutputPresentationMetadata {
  return {
    segmentKind: 'final',
    visible: Boolean(text),
    displaySurface: 'assistant_bubble',
  };
}

export function approvalOutputPresentation(): OutputPresentationMetadata {
  return {
    segmentKind: 'approval',
    visible: true,
    displaySurface: 'approval',
  };
}

export function statusOutputPresentation(
  visible: boolean,
): OutputPresentationMetadata {
  return {
    segmentKind: 'status',
    visible,
    displaySurface: visible ? 'assistant_bubble' : 'none',
  };
}
