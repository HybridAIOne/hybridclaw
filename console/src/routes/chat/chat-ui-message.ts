import type { ChatMessage } from '../../api/chat-types';

export type ThinkingChatMessage = Omit<ChatMessage, 'role' | 'content'> & {
  role: 'thinking';
  content: '';
};

export type ChatUiMessage = ChatMessage | ThinkingChatMessage;
