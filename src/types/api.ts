/**
 * Model messages retain tool IDs and opaque provider replay metadata across
 * gateway/worker boundaries. These types describe protocol data, not approval
 * or the transport-facing conversation presentation.
 */
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
  | ChatContentAudioUrlPart;

export type ChatMessageContent = string | ChatContentPart[] | null;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatMessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
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
