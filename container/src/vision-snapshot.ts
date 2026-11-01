/**
 * Snapshot analysis reuses the authorized read's durable pixels, one image per call.
 * The caller enforces visual-data permission; the existing snapshot loader enforces
 * ownership, page selection and integrity. This never renders or reads arbitrary paths.
 */
import {
  loadVisualSnapshot,
  validateVisualAttachments,
} from '../shared/visual-snapshots.js';
import type { AuxiliaryRuntimeContext } from './model-context.js';
import { callAuxiliaryModel } from './providers/auxiliary.js';
import {
  WORKSPACE_ROOT_DISPLAY,
  WORKSPACE_STATE_ROOT,
} from './runtime-paths.js';
import type { ToolDefinition } from './types.js';

// Existing vision-tool limit, shared by file, URL and snapshot inputs.
export const VISION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export const VISION_ANALYZE_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'vision_analyze',
    description: `Analyze an image with the configured vision model. Use a durable snapshot reference offered after read, or a local image path from ${WORKSPACE_ROOT_DISPLAY}, /discord-media-cache, or /uploaded-media-cache. Use a Discord CDN fallback URL only when no local path is readable. Each call analyzes one image or selected original PDF page.`,
    parameters: {
      type: 'object',
      properties: {
        image_url: {
          type: 'string',
          description: `Local image path from ${WORKSPACE_ROOT_DISPLAY}, /discord-media-cache, or /uploaded-media-cache, an artifact URL copied from chat history, or a Discord CDN HTTPS URL. Choose image_url or snapshot.`,
        },
        snapshot: {
          type: 'object',
          description:
            'Durable visual snapshot reference offered after read. Copy it unchanged; choose an original PDF page with page.',
        },
        page: {
          type: 'number',
          description:
            'One original PDF page from the snapshot selection. Required for multi-page snapshots; omit for standalone images.',
        },
        question: {
          type: 'string',
          description: 'Question to ask about the image.',
        },
        fallback_url: {
          type: 'string',
          description:
            'Optional fallback Discord CDN URL if the local image path cannot be read.',
        },
        original_url: {
          type: 'string',
          description: 'Optional original URL alias for fallback_url.',
        },
      },
      required: ['question'],
    },
  },
};

export async function analyzeVisualSnapshot(
  input: { snapshot: unknown; page: unknown; question: string },
  runtimeContext: AuxiliaryRuntimeContext,
  toolName: string,
): Promise<string> {
  const [ref] = validateVisualAttachments([input.snapshot]);
  const page =
    input.page === undefined
      ? ref.pages.length === 1
        ? ref.pages[0]
        : undefined
      : input.page;
  const index = ref.pages.length ? ref.pages.indexOf(page as number) : 0;
  if (
    (ref.pages.length && (!Number.isSafeInteger(page) || index < 0)) ||
    (!ref.pages.length && input.page !== undefined)
  ) {
    throw new Error(
      'Choose one original page from the snapshot selection; omit page for standalone images.',
    );
  }
  const snapshot = await loadVisualSnapshot(WORKSPACE_STATE_ROOT, ref);
  const image = snapshot.images[index];
  if (!image)
    throw new Error(
      'Selected snapshot page has no rendered image; re-read the original file.',
    );
  const bytes = Buffer.byteLength(image, 'base64');
  if (bytes > VISION_IMAGE_MAX_BYTES) {
    throw new Error(
      `snapshot image exceeds max size (${VISION_IMAGE_MAX_BYTES} bytes)`,
    );
  }
  const vision = await callAuxiliaryModel({
    task: 'vision',
    taskModels: runtimeContext.taskModels,
    fallbackContext: runtimeContext.fallbackContext,
    question: input.question,
    imageDataUrl: `data:image/png;base64,${image}`,
    toolName,
  });
  return JSON.stringify({
    success: true,
    model: vision.model,
    analysis: vision.analysis,
    snapshot: ref,
    page,
    mime_type: 'image/png',
    size_bytes: bytes,
  });
}
