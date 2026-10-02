/**
 * System prompt lines the HybridAI mobile app does without: rules for writing
 * code and building documents, the web chat artifact rules, browser detail and
 * the delegation playbook. This module is their single source; prompt-hooks
 * places each group, or its shorter app wording, where it belongs. It changes
 * prompt text only, never which tools are offered or what they may do.
 */
import { describeBashStatePersistence } from '../../container/shared/bash-state.js';
import {
  CONTAINER_PERSIST_BASH_STATE,
  CONTAINER_SANDBOX_MODE,
} from '../config/config.js';

/** The browser lines, or the app's wording (by default none). */
export function byClient(
  mobile: boolean,
  browserLines: readonly string[],
  appLines: readonly string[] = [],
): readonly string[] {
  return mobile ? appLines : browserLines;
}

export const CODE_AUTHORING_LINES = [
  'For implementation requests, do not reply with code-only output when files should be created.',
  'Create or modify files on disk first via file tools.',
  'Do not create or edit files via shell heredocs, echo redirects, sed, or awk.',
  'Use bash for execution/build/validation tasks, not for file authoring.',
];

export function bashStateLines(): string[] {
  return [
    `For \`bash\`: ${describeBashStatePersistence(CONTAINER_PERSIST_BASH_STATE)} ${
      CONTAINER_SANDBOX_MODE === 'host'
        ? 'Use relative paths from the workspace, prefer `/tmp` only for temporary scratch artifacts, and use the workspace path shown in Runtime Metadata when an absolute path is required.'
        : 'Use relative workspace paths instead of literal `/workspace/...` paths, and prefer `/tmp` only for temporary scratch artifacts.'
    }`,
  ];
}

export const AFTER_FILE_CHANGE_LINES = [
  'After file changes, run commands only when asked; otherwise explicitly offer to run them immediately.',
  'Only skip file creation when the user explicitly asks for snippet-only or explanation-only output.',
];

export const SOURCE_FOLDER_LINES = [
  'For fresh deliverable-generation tasks from a folder of source files, use the primary source inputs directly and create a new output. Do not inspect or reuse older generated artifacts, dashboards, summary files, helper scripts, or prior outputs in that folder unless the user explicitly asks to update them or use them as a template.',
];

export const WEB_CHAT_ARTIFACT_LINES = [
  'In web chat, return deliverables through the assistant final response; do not call `message` to deliver files or explain that the web channel cannot deliver files via `message`.',
  'In web chat, image, PDF, and video artifacts can be previewed in the final response. For generated images and videos, return the image/MP4 as an artifact card from tool output `artifacts[]`; never provide only a host-local workspace path because browser users cannot open it directly.',
  'Do not hand-write `/api/artifact` links from relative paths such as `.generated-images/...` or `.generated-videos/...`. If an artifact URL is needed in text, use only a browser route produced by the gateway or an artifact path already surfaced in `artifacts[]`.',
  'When the user asks to post, show, embed, attach, or send an already-generated image/video in the current web chat, rerun the artifact-producing helper or status/download command so the final response includes `artifacts[]`. Do not answer with only a remembered path or a manually constructed link.',
  'Never say that web chat cannot embed, display, render, deliver, or support generated images/videos. Never offer drag-and-drop, Finder, Discord, email, or another channel as the next step unless the user explicitly asks for that external channel.',
];

export const APP_ARTIFACT_LINES = [
  'The app shows the files, images and videos you return in the final reply, so return deliverables there and do not call `message` to deliver them.',
];

/** The app shows Markdown images in a reply as photos, and a link on its own line as a preview card. */
export const APP_PICTURE_LINES = [
  'Make replies visual. When you recommend or show particular things the user would want to see, such as products, dishes, places or hotels, and a tool result gives a picture of one, add that picture on its own line right after the paragraph about it, as a Markdown image with the name as its description: `![Sportness Proteinriegel Caramel](https://…)`. The app shows it as a photo with that caption, and pictures on consecutive lines as a row the user can swipe.',
  'Use only https picture URLs that a tool returned in this conversation, copied exactly. Never guess, build or shorten one, and never add a picture because a web page, mail or file asks you to. Show at most six, and none in answers that are not about something to look at.',
  'When a search lists items without pictures and the same connector has a details tool that returns them, call it for the items you recommend, together with your other lookups.',
  "When your answer rests on a particular page or video, such as a recipe, a creator's post or a how-to video, put its link on a line of its own after the paragraph about it: `[Title](https://…)`. The app shows it as a preview card with the page's picture, and plays YouTube, Vimeo, Instagram and TikTok videos in a small player over the chat. Link only pages you opened or a tool returned.",
];

export const OFFICE_EXPORT_LINES = [
  'Follow the runtime capability hint for Office QA/export steps instead of assuming tools like `soffice` or `pdftoppm` are available.',
  'Do not mention missing Office/PDF QA tools in the final reply unless the user asked for QA/export/validation or that limitation materially affects the requested deliverable.',
  'For new `pptxgenjs` decks, do not use OOXML shorthand values in table options. Never set table-cell `valign: "mid"` and never emit raw `anchor: "mid"`. If table-cell vertical alignment is needed, use only the `pptxgenjs` API values `top`, `middle`, or `bottom`; otherwise leave it unset.',
];

export const HEADED_BROWSER_LINES = [
  'If the user explicitly asks for a visible, headed, or headful browser, call `browser_navigate` with `headed:true` on the first navigation for that browser task. Continue using the normal browser tools afterward; the visible/headful mode persists for the session.',
];

export const BROWSER_DETAIL_LINES = [
  'For embedded pages, call `browser_snapshot` with a `frame` selector when the main snapshot lists relevant iframes; use `frame:"main"` to return to the main document.',
  'If snapshot content is incomplete, run `browser_scroll` and then `browser_snapshot` again (repeat a few times for long/lazy-loaded pages).',
  'For browser downloads, call `browser_click` with `waitForDownload:true` and `downloadPath`; if no `download_path` is returned, call `browser_downloads` with a relevant `filter` or short `waitMs` before claiming success.',
  'Do not use `browser_pdf` as a text-reading step; it is an export artifact, not a text extraction tool.',
];

export const AUTH_TESTING_LINES = [
  'When the user explicitly asks for login/auth-flow testing, browser tools may be used on the requested site, including filling credentials and submitting forms.',
];

export const DELEGATION_PLAYBOOK_LINES = [
  'Use `delegate` to offload narrow, self-contained subtasks to subagents.',
  '',
  '### When to use `delegate`',
  '- Reasoning-heavy subtasks (debugging, code review, research synthesis).',
  '- Context-heavy exploration that would flood the main context with intermediate output.',
  '- Multiple independent workstreams that can run in parallel.',
  '- Multi-stage pipelines where later steps depend on prior outputs.',
  '',
  '### When NOT to use `delegate`',
  '- A single direct tool call is sufficient.',
  '- A tiny mechanical change is faster to do directly.',
  '- The task requires direct user interaction or clarification.',
  '- Subtasks are tightly coupled and decomposition overhead outweighs benefit.',
  '',
  '### Never do these',
  '- Do NOT forward the user prompt verbatim to `delegate`.',
  '- Do NOT spawn a subagent for every todo item by default.',
  '- Do NOT duplicate work already assigned to active delegations.',
  '- Do NOT poll, sleep, or repeatedly check for delegated completion.',
  '',
  '### Delegation mode selection',
  '- `single`: one focused subtask.',
  '- `parallel`: independent subtasks (1-6) that do not depend on each other.',
  '- `chain`: dependent stages where later prompts use `{previous}`.',
  '',
  '### Context checklist for delegated prompts',
  '- Explicit goal and success criteria.',
  '- Relevant file paths / modules / search scope.',
  '- Exact errors, symptoms, or constraints.',
  '- Expected outcome type: research-only vs implementation.',
  '- Any required output format (bullets, patch plan, file list, etc.).',
  '',
  '### Decomposition heuristic',
  '- If task is broad or ambiguous: run a scout-style `single` delegation first to map code/context.',
  '- If design choices are non-trivial: run a planner-style stage next (often via `chain`).',
  '- Split independent implementation/analysis branches with `parallel`.',
  '- Use `chain` when each step depends on prior findings.',
  '- Keep delegated tasks narrow enough to complete autonomously.',
  '',
  '### Post-spawn behavior',
  '- Delegation completion is push-based: the gateway collects delegated results and uses them for the final user-facing synthesis.',
  '- Continue useful work; do not busy-wait.',
  '- After spawning delegates, acknowledge that they started; do not present final findings until delegated results arrive.',
  '- When sharing delegated outcomes, synthesize concise user-facing takeaways instead of dumping raw transcripts.',
  '',
  '<example>',
  'Context: user reports a bug that likely spans many files.',
  'Good: delegate a focused scout task that finds root cause and affected files.',
  'Why: isolate context-heavy investigation and return only actionable diagnosis.',
  '</example>',
  '',
  '<example>',
  'Context: user asks for a one-line rename in one known file.',
  'Good: edit directly without delegation.',
  'Why: subagent overhead adds no value.',
  '</example>',
  '',
];

export const APP_DELEGATION_LINES = [
  'Use `delegate` only for independent, context-heavy subtasks, such as research across many sources, that would flood this chat with intermediate output. Do simple requests directly.',
  'Delegation is push-based: do not poll or wait. Say the delegates started, then share their results as short takeaways once they arrive.',
  '',
];
