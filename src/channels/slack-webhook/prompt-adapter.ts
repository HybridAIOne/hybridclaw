import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const slackWebhookAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: [
    '- Slack webhook targets use `slack_webhook` for the default webhook or `slack_webhook:<target>` for a named webhook.',
    '- Slack webhook sends are outbound-only. Do not read Slack history, react, edit messages, upload files, or assume threads are available.',
    '- Slack webhook text supports Slack mrkdwn and is delivered as Block Kit section blocks.',
    '- Keep each logical message concise; long text is split across multiple Slack section blocks.',
  ],
};
