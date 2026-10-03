/**
 * YouTube video links for web_fetch: the watch page keeps title, channel and
 * description in the `ytInitialPlayerResponse` JSON, not in visible HTML, so
 * readability only finds the footer. This module reads that JSON, adds a
 * best-effort transcript, and falls back to oEmbed (title + channel) when the
 * page is walled. It never guesses content and does no HTTP of its own: every
 * request goes through web-fetch's SSRF-guarded fetcher.
 */

import { decodeEntities } from './search-utils.js';

export interface FetchTextRequest {
  method?: 'POST';
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type FetchText = (
  url: string,
  request?: FetchTextRequest,
) => Promise<{ status: number; text: string }>;

export interface YouTubeVideoResult {
  title?: string;
  text: string;
  extractor: 'youtube' | 'youtube-oembed';
  // Set when a browser could plausibly read what this fetch could not.
  browserMayHelp: boolean;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text?: string }[] };
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    title?: string;
    author?: string;
    channelId?: string;
    lengthSeconds?: string;
    viewCount?: string;
    shortDescription?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      publishDate?: string;
      ownerProfileUrl?: string;
    };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: { audioTrackId?: string }[];
      defaultAudioTrackIndex?: number;
    };
  };
}

const VIDEO_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
// SOCS=CAI is the "reject all" consent choice, so EU requests get the watch
// page instead of a redirect to consent.youtube.com.
const CONSENT_COOKIE = 'SOCS=CAI';
// The watch page's caption URLs need a PO token and come back empty; the
// Android player client's do not. Client version (2026-10-03, verified from a
// residential IP): if YouTube retires it, the transcript is simply omitted.
const ANDROID_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38' };
const TRANSCRIPT_TIMEOUT_MS = 8_000;
// 30,000 chars (2026-10-03): about a 30-minute talk, leaving room for the
// description within web_fetch's 50,000-char cap.
const TRANSCRIPT_MAX_CHARS = 30_000;

export function youtubeVideoId(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const [first, second] = url.pathname.split('/').filter(Boolean);
  let id: string | null | undefined;
  if (host === 'youtu.be') id = first;
  else if (!YOUTUBE_HOSTS.has(host)) return undefined;
  else if (first === 'watch') id = url.searchParams.get('v');
  else if (['shorts', 'live', 'embed'].includes(first ?? '')) id = second;
  return id && VIDEO_ID.test(id) ? id : undefined;
}

/** Parses the `ytInitialPlayerResponse = {...}` object by brace matching. */
export function extractPlayerResponse(html: string): PlayerResponse | null {
  const match = /ytInitialPlayerResponse"?\]?\s*=\s*\{/.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1)) as PlayerResponse;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * The video's spoken language first (the default audio track, else the
 * auto-generated track, which follows the audio), then manual over
 * auto-generated captions.
 */
function pickCaptionTrack(player: PlayerResponse): CaptionTrack | undefined {
  const list = player.captions?.playerCaptionsTracklistRenderer;
  const tracks = (list?.captionTracks ?? []).filter((track) => track.baseUrl);
  const baseLanguage = (code?: string) => code?.split(/[-.]/)[0];
  const language = baseLanguage(
    list?.audioTracks?.[list.defaultAudioTrackIndex ?? 0]?.audioTrackId ??
      tracks.find((track) => track.kind === 'asr')?.languageCode,
  );
  const rank = (track: CaptionTrack) =>
    (baseLanguage(track.languageCode) === language ? 0 : 2) +
    (track.kind === 'asr' ? 1 : 0);
  return tracks.sort((a, b) => rank(a) - rank(b))[0];
}

export function transcriptFromXml(xml: string): string {
  const lines: string[] = [];
  for (const [, body] of xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
    // Caption text is entity-encoded twice (`&amp;#39;`).
    const line = decodeEntities(decodeEntities(body)).replace(/\s+/g, ' ');
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join(' ');
}

async function readTranscript(
  player: PlayerResponse | null,
  fetchText: FetchText,
  signal: AbortSignal,
): Promise<{ label: string; text: string } | null> {
  const track = player && pickCaptionTrack(player);
  if (!track?.baseUrl) return null;
  const url = new URL(track.baseUrl);
  url.searchParams.delete('fmt');
  const { status, text: xml } = await fetchText(url.href, { signal });
  const text = status === 200 ? transcriptFromXml(xml) : '';
  if (!text) return null;
  const label =
    track.name?.simpleText ??
    track.name?.runs?.map((run) => run.text ?? '').join('') ??
    track.languageCode ??
    '';
  return {
    label,
    text:
      text.length > TRANSCRIPT_MAX_CHARS
        ? `${text.slice(0, TRANSCRIPT_MAX_CHARS)} … (transcript truncated)`
        : text,
  };
}

async function readAndroidPlayer(
  videoId: string,
  fetchText: FetchText,
  signal: AbortSignal,
): Promise<PlayerResponse | null> {
  const { status, text } = await fetchText(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      method: 'POST',
      body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
      headers: { 'Content-Type': 'application/json' },
      signal,
    },
  );
  return status === 200 ? (JSON.parse(text) as PlayerResponse) : null;
}

async function readOEmbed(
  watchUrl: string,
  fetchText: FetchText,
): Promise<{ title?: string; author_name?: string; author_url?: string }> {
  const { status, text } = await fetchText(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`,
  );
  if (status !== 200) {
    throw new Error(`YouTube oEmbed failed (${status})`);
  }
  return JSON.parse(text);
}

export async function readYouTubeVideo(
  videoId: string,
  fetchText: FetchText,
  signal: AbortSignal,
): Promise<YouTubeVideoResult> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const sideSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
  ]);
  const [page, android] = await Promise.all([
    fetchText(watchUrl, { headers: { Cookie: CONSENT_COOKIE } }),
    readAndroidPlayer(videoId, fetchText, sideSignal).catch(() => null),
  ]);
  const player = page.status === 200 ? extractPlayerResponse(page.text) : null;
  const details = player?.videoDetails ?? android?.videoDetails;

  if (!details?.title) {
    const reason = player?.playabilityStatus?.reason;
    let oembed: Awaited<ReturnType<typeof readOEmbed>>;
    try {
      oembed = await readOEmbed(watchUrl, fetchText);
    } catch (error) {
      throw new Error(
        `YouTube video ${videoId} could not be read${reason ? `: ${reason}` : ''} (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    return {
      title: oembed.title,
      extractor: 'youtube-oembed',
      // A page without player JSON (consent page) may open in a browser; a
      // player wall ("confirm you're not a bot") or 429 hits a browser on the
      // same network too.
      browserMayHelp: page.status === 200 && !player,
      text: [
        `Channel: ${oembed.author_name ?? 'unknown'}${oembed.author_url ? ` (${oembed.author_url})` : ''}`,
        `URL: ${watchUrl}`,
        '',
        `The video description and transcript could not be read${reason ? ` (YouTube: "${reason}")` : ''}. Only the title and channel are known; do not guess what the video shows.`,
      ].join('\n'),
    };
  }

  const transcript = await readTranscript(android, fetchText, sideSignal).catch(
    () => null,
  );
  const micro = player?.microformat?.playerMicroformatRenderer;
  const channelUrl =
    micro?.ownerProfileUrl?.replace(/^http:/, 'https:') ??
    (details.channelId
      ? `https://www.youtube.com/channel/${details.channelId}`
      : undefined);
  const seconds = Number(details.lengthSeconds);
  const views = Number(details.viewCount);
  const meta = [
    `Channel: ${details.author ?? 'unknown'}${channelUrl ? ` (${channelUrl})` : ''}`,
    micro?.publishDate ? `Published: ${micro.publishDate.slice(0, 10)}` : '',
    seconds > 0 ? `Duration: ${formatDuration(seconds)}` : '',
    views >= 0 && details.viewCount
      ? `Views: ${views.toLocaleString('en-US')}`
      : '',
    `URL: ${watchUrl}`,
  ].filter(Boolean);
  return {
    title: details.title,
    extractor: 'youtube',
    browserMayHelp: false,
    text: [
      ...meta,
      '',
      '## Description',
      '',
      details.shortDescription?.trim() || '(no description)',
      '',
      transcript ? `## Transcript: ${transcript.label}` : '## Transcript',
      '',
      transcript?.text ?? 'No transcript available.',
    ].join('\n'),
  };
}
