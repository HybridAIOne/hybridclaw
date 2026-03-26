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
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
