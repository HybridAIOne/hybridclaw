import { Buffer } from 'node:buffer';

import type { CdpTransport } from './cdp-transport.js';
import type { BrowserScreenshotResult } from './types.js';

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 2_000;

type LayoutMetrics = {
  contentSize?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  cssLayoutViewport?: {
    pageX?: number;
    pageY?: number;
    clientWidth?: number;
    clientHeight?: number;
  };
};

type ScreenshotTransport = Pick<CdpTransport, 'send'>;

async function rawCapture(
  connection: ScreenshotTransport,
  sessionId: string,
  options: { fullPage?: boolean; scale: number },
): Promise<BrowserScreenshotResult> {
  const metrics = await connection.send<LayoutMetrics>(
    'Page.getLayoutMetrics',
    {},
    { sessionId },
  );
  const contentWidth = Math.max(
    1,
    Math.ceil(Number(metrics.contentSize?.width || 0) || 1),
  );
  const contentHeight = Math.max(
    1,
    Math.ceil(Number(metrics.contentSize?.height || 0) || 1),
  );
  const viewportWidth = Math.max(
    1,
    Math.ceil(Number(metrics.cssLayoutViewport?.clientWidth || contentWidth)),
  );
  const viewportHeight = Math.max(
    1,
    Math.ceil(Number(metrics.cssLayoutViewport?.clientHeight || contentHeight)),
  );

  const rawWidth = options.fullPage ? contentWidth : viewportWidth;
  const rawHeight = options.fullPage ? contentHeight : viewportHeight;
  const clip =
    options.scale < 0.999 || options.fullPage
      ? {
          x: Number(metrics.cssLayoutViewport?.pageX || 0),
          y: Number(metrics.cssLayoutViewport?.pageY || 0),
          width: rawWidth,
          height: rawHeight,
          scale: options.scale,
        }
      : undefined;

  const captured = await connection.send<{ data?: string }>(
    'Page.captureScreenshot',
    {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: options.fullPage === true,
      ...(clip ? { clip } : {}),
    },
    { sessionId, timeoutMs: 60_000 },
  );
  const base64 = String(captured.data || '');
  if (!base64) throw new Error('Screenshot capture returned empty data');

  return {
    base64,
    width: Math.max(1, Math.round(rawWidth * options.scale)),
    height: Math.max(1, Math.round(rawHeight * options.scale)),
    clipX: Number(clip?.x || 0),
    clipY: Number(clip?.y || 0),
    scale: options.scale,
  };
}

export async function captureNormalizedScreenshot(
  connection: ScreenshotTransport,
  sessionId: string,
  options: { fullPage?: boolean } = {},
): Promise<BrowserScreenshotResult> {
  const metrics = await connection.send<LayoutMetrics>(
    'Page.getLayoutMetrics',
    {},
    { sessionId },
  );
  const rawWidth = Math.max(
    1,
    Math.ceil(
      Number(
        options.fullPage
          ? metrics.contentSize?.width
          : metrics.cssLayoutViewport?.clientWidth,
      ) || 1,
    ),
  );
  const rawHeight = Math.max(
    1,
    Math.ceil(
      Number(
        options.fullPage
          ? metrics.contentSize?.height
          : metrics.cssLayoutViewport?.clientHeight,
      ) || 1,
    ),
  );
  let scale = Math.min(
    1,
    MAX_SCREENSHOT_DIMENSION / rawWidth,
    MAX_SCREENSHOT_DIMENSION / rawHeight,
  );
  scale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const screenshot = await rawCapture(connection, sessionId, {
      fullPage: options.fullPage,
      scale,
    });
    const byteLength = Buffer.from(screenshot.base64, 'base64').byteLength;
    if (byteLength <= MAX_SCREENSHOT_BYTES || scale <= 0.25) {
      return screenshot;
    }
    scale = Math.max(0.25, scale * 0.75);
  }

  return rawCapture(connection, sessionId, {
    fullPage: options.fullPage,
    scale,
  });
}
