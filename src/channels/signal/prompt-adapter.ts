import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const signalAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: [
    '- Normal assistant replies go back to the current Signal chat automatically.',
    '- Signal replies should stay concise and avoid markdown — Signal renders plain text only.',
    '- Signal send targets must use canonical ids like `signal:+15551234567`, `signal:<uuid>`, or `signal:group:<groupId>`.',
    '- For `message` sends from Signal, use an explicit Signal target such as `signal:+15551234567` when routing somewhere else.',
    '- Avoid Discord-specific mention syntax like `<@userId>` in Signal replies.',
  ],
};
