/**
 * `show_widget` (container/src/tools/widget.ts) draws a small interactive view
 * inside the HybridAI app's chat. Only the app can show one, so every other
 * client and scheduled runs never see the tool.
 */
export const SHOW_WIDGET_TOOL = 'show_widget';
/** The media type its artifacts carry; they belong to a reply, not the Apps gallery. */
export const WIDGET_MIME_TYPE = 'application/vnd.hybridai.widget+html';
/**
 * `draft_transfer` (container/src/tools/transfer.ts): a bank transfer the app
 * shows as a card with a GiroCode. Only the app draws it, too.
 */
export const DRAFT_TRANSFER_TOOL = 'draft_transfer';
/**
 * `show_dashboard` (container/src/tools/dashboard.ts): figures, charts and
 * tables the app draws natively, each with its query. Only the app draws it.
 */
export const SHOW_DASHBOARD_TOOL = 'show_dashboard';
