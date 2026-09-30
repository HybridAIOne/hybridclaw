/**
 * Model messages retain tool IDs and opaque provider replay metadata across
 * gateway/worker boundaries. These types describe protocol data, not approval
 * or the transport-facing conversation presentation.
 */
import type {
  PdfFilePart,
  VisualAttachmentMessage,
} from '../../container/shared/visual-snapshots.js';

export interface ChatContentTextPart {
  type: 'text';
  text: string;
}

export interface ChatContentImageUrlPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export interface ChatContentAudioUrlPart {
  type: 'audio_url';
  audio_url: {
    url: string;
  };
}

export type ChatContentPart =
  | ChatContentTextPart
  | ChatContentImageUrlPart
  | ChatContentAudioUrlPart
  | PdfFilePart;

export type ChatMessageContent = string | ChatContentPart[] | null;

export interface ChatMessage extends VisualAttachmentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatMessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  is_error?: boolean;
  anthropic_content?: Array<{ type: string; [key: string]: unknown }>;
  openai_response_items?: Array<Record<string, unknown>>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
