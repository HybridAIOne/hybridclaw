/**
 * Model messages retain tool IDs and opaque provider replay metadata across
 * gateway/worker boundaries. These types describe protocol data, not approval
 * or the transport-facing conversation presentation. Result digests identify
 * saved evidence and are removed before provider requests.
 */
export type {
  ChatContentAudioUrlPart,
  ChatContentImageUrlPart,
  ChatContentPart,
  ChatContentTextPart,
  ChatMessage,
  ChatMessageContent,
  ToolCall,
} from '@hybridclaw/contracts/agent-io';
