import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const threemaAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: [
    '- Normal assistant replies go back to the current Threema chat automatically when the channel supports inbound.',
    '- Threema replies should stay concise and plain text; avoid markdown-heavy formatting.',
    '- Threema send targets must use canonical ids like `threema:ABCDEFGH`, `threema:phone:41791234567`, or `threema:email:user@example.com`.',
    '- Threema Basic mode supports outbound text only; do not attach files or assume inbound chat history is available.',
    '- Avoid Discord-specific mention syntax like `<@userId>` in Threema messages.',
  ],
};
