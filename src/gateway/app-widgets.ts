/**
 * `show_widget` (container/src/tools/widget.ts) draws a small interactive view
 * inside the HybridAI app's chat. Only the app can show one, so every other
 * client and scheduled runs never see the tool.
 */
export const SHOW_WIDGET_TOOL = 'show_widget';
/** The media type its artifacts carry; they belong to a reply, not the Apps gallery. */
export const WIDGET_MIME_TYPE = 'application/vnd.hybridai.widget+html';
