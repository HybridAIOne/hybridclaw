export interface GatewayCommandResult {
  kind: 'plain' | 'info' | 'error';
  title?: string;
  text: string;
}

export interface GatewayChatResult {
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  error?: string;
}

export interface GatewayChatRequestBody {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string | null;
  content: string;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
}

export interface GatewayCommandRequest {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  args: string[];
}

export interface GatewayStatus {
  status: 'ok';
  uptime: number;
  sessions: number;
  activeContainers: number;
  defaultModel: string;
  ragDefault: boolean;
  timestamp: string;
}

export function renderGatewayCommand(result: GatewayCommandResult): string {
  if (!result.title) return result.text;
  return `${result.title}\n${result.text}`;
}
