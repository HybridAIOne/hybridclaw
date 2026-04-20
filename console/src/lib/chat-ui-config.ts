import chatUiConfig from '../../../docs/static/chat-ui-config.json';

type ChatUiConfig = {
  maxRecentSessions: number;
  maxSearchResults: number;
};

export const CHAT_UI_CONFIG = chatUiConfig as ChatUiConfig;
