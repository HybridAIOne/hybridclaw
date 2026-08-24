export interface ParsedSessionKey {
  agentId: string;
  channelKind: string;
  chatType: string;
  peerId: string;
  threadId?: string;
  topicId?: string;
  subagentId?: string;
}

export declare function buildSessionKey(
  agentId: string,
  channelKind: string,
  chatType: string,
  peerId: string,
  options?: {
    threadId?: string;
    topicId?: string;
    subagentId?: string;
  },
): string;

export declare function parseSessionKey(key: string): ParsedSessionKey | null;
