/**
 * Reply fetch guard — a reply holds an address that clients fetch without a
 * tap only when the session held that exact address before the model wrote
 * it: in a user message or a tool result, and not first in the model's own
 * tool arguments or replies.
 *
 * Clients fetch a Markdown picture `![…](url)`, and the apps also preview a
 * link on a line of its own, as soon as they show the reply. Without this an
 * injected instruction could make the model write such an address with
 * private data in it, and the user's device would send it without a tap. An
 * unvouched picture keeps only its description; an unvouched link on its own
 * line joins the line before it, where it stays a link to tap.
 *
 * The streamed text and the stored reply follow the same rules, so the
 * stream is always the start of the stored reply. NOT a link filter: a link
 * inside a sentence costs nothing until it is opened. Addresses the model
 * laundered through state it wrote earlier (files, memory, scheduled prompts)
 * still count as seen.
 */
import { getMessageTextContent } from '../agent/middleware.js';
import type { ChatMessage } from '../types/api.js';
import type { ToolExecution, ToolProgressEvent } from '../types/execution.js';
import { isDelegationResultsMessage } from './delegation-results-message.js';

// 4096 chars (2026-10-02): room for signed CDN addresses. A longer `![…](…)` is
// escaped and shown as text, so the stream never holds more than this.
const MAX_IMAGE_CHARS = 4_096;
const URL_RE = /https?:\/\/[^\s"'<>`\\]+/gi;
// Workspace paths and sandbox: links name the user's own files; no client
// fetches them from the web.
const LOCAL_TARGET_RE = /^(?:sandbox:)?(?!\/\/)[\w./~-][\w./~%=?+-]*$/;
// Renderers disagree on code spans, escapes and nesting inside a description,
// so a picture is shown only when its description has none of them.
const PLAIN_LABEL_RE = /^[^`!<>\\[\]\n]*$/;
// The links the apps find on a line (LinkPreview.split in the iOS app):
// Markdown, <angle> and bare, matched in that order.
const LINE_LINK_RE =
  /\[[^[\]\n]*\]\(\s*<?((?:[^()<>\s]|\([^()<>\s]*\))+)>?\s*\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>[\]]+)/gi;
const LETTER_RE = /\p{L}/u;
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  '#39': "'",
  lt: '<',
  gt: '>',
};

type Source = { said: boolean; text: string };
type Decision = 'show' | 'describe' | 'wait';
type Scanned =
  | 'open'
  | 'text'
  | 'overlong'
  | { end: number; label: string; inner: string };

export class ReplyFetchGuard {
  private readonly sources: Source[] = [];
  private read = 0;
  // Where in `written` each address had got to when it was first seen.
  private readonly seenAt = new Map<string, number>();
  private written = '';
  private previewsComplete = true;
  private pending = '';
  private readonly lines = new OwnLineLinks((url) => this.seen(url));

  constructor(
    messages: readonly ChatMessage[],
    private readonly emit: (text: string) => void,
  ) {
    for (const message of messages) {
      if (message.role === 'system') continue;
      const text = getMessageTextContent(message);
      // The delegate results turn is the children's own writing.
      const said =
        message.role === 'tool' ||
        (message.role === 'user' && !isDelegationResultsMessage(text));
      this.sources.push({ said, text });
      for (const call of message.tool_calls ?? [])
        this.sources.push({ said: false, text: call.function.arguments });
    }
  }

  push(delta: string): void {
    this.pending += delta;
    const { out, rest } = render(this.pending, false, this.decide);
    this.pending = this.pending.slice(rest);
    this.send(this.lines.take(out, false));
  }

  // A result preview counts only while every call this turn showed its full
  // arguments; otherwise its addresses wait for the turn's tool executions.
  noteToolProgress(event: ToolProgressEvent): void {
    const preview = event.preview || '';
    if (event.phase === 'start') {
      this.previewsComplete &&= isJsonObject(preview);
      this.sources.push({ said: false, text: preview });
      // Text written before a tool call ends there.
      this.flush();
    } else if (this.previewsComplete) {
      this.sources.push({ said: true, text: preview });
    }
  }

  finish(executions: readonly ToolExecution[] = []): void {
    for (const execution of executions) {
      this.sources.push(
        { said: false, text: execution.arguments },
        { said: true, text: execution.result },
      );
    }
    this.flush();
  }

  rewrite(text: string): string {
    const images = render(text, true, this.decide).out;
    return new OwnLineLinks((url) => this.seen(url)).take(images, true);
  }

  private flush(): void {
    const { out } = render(this.pending, true, this.decide);
    this.pending = '';
    this.send(this.lines.take(out, true));
  }

  private send(text: string): void {
    if (text) this.emit(text);
  }

  private readonly decide = (inner: string): Decision => {
    const trimmed = inner.trim();
    const target = trimmed.startsWith('<')
      ? trimmed.endsWith('>')
        ? trimmed.slice(1, -1)
        : ''
      : trimmed;
    // A title, or anything else beside the address, is not worth a fetch.
    if (!target || /\s/.test(target)) return 'describe';
    if (LOCAL_TARGET_RE.test(target)) return 'show';
    return this.seen(target) ? 'show' : 'wait';
  };

  private seen(url: string): boolean {
    for (; this.read < this.sources.length; this.read += 1) {
      const { said, text } = this.sources[this.read];
      if (!said) {
        this.written += `\n${readableForms(text, true).join('\n')}`;
        continue;
      }
      for (const found of urlsIn(text)) {
        if (!this.seenAt.has(found))
          this.seenAt.set(found, this.written.length);
      }
    }
    const at = this.seenAt.get(url);
    if (at === undefined) return false;
    // Seen before the model wrote it, or it never did.
    const bare = url.replace(/^https?:\/\//i, '');
    const wrote = this.written.indexOf(bare);
    return wrote < 0 || wrote + bare.length > at;
  }
}

// Unless `final`, stops at a picture the turn's tool results may still vouch
// for, or one not yet complete, and returns where it stopped. Only a picture
// shown exactly as written keeps a live `![`; every other one is escaped, so
// nothing removed here can join its neighbours into a new picture.
function render(
  text: string,
  final: boolean,
  decide: (inner: string) => Decision,
): { out: string; rest: number } {
  let out = '';
  let index = 0;
  for (;;) {
    const at = text.indexOf('![', index);
    // A closing `!` may still open a picture.
    const end =
      at >= 0
        ? at
        : final || !text.endsWith('!')
          ? text.length
          : text.length - 1;
    out += text.slice(index, end);
    if (at < 0) return { out, rest: end };
    const image = scanImage(text, at);
    if (image === 'open' && !final) return { out, rest: at };
    if (typeof image === 'string') {
      out += '!\\[';
      index = at + 2;
      continue;
    }
    let decision = PLAIN_LABEL_RE.test(image.label)
      ? decide(image.inner)
      : 'describe';
    if (decision === 'wait') {
      if (!final) return { out, rest: at };
      decision = 'describe';
    }
    if (decision === 'show') {
      out += text.slice(at, image.end);
    } else {
      let description = render(image.label, true, () => 'describe').out;
      // Spaced so it cannot finish a `![` before it or start one after it.
      if (description.startsWith('[')) description = ` ${description}`;
      if (!description || description.endsWith('!')) description += ' ';
      out += description;
    }
    index = image.end;
  }
}

function scanImage(text: string, at: number): Scanned {
  const limit = Math.min(text.length, at + MAX_IMAGE_CHARS);
  const more = text.length < at + MAX_IMAGE_CHARS ? 'open' : 'overlong';
  const close = matching(text, at + 1, limit, '[', ']');
  if (close < 0 || close + 1 >= limit) return more;
  if (text[close + 1] !== '(') return 'text';
  const end = matching(text, close + 1, limit, '(', ')');
  if (end < 0) return more;
  return {
    end: end + 1,
    label: text.slice(at + 2, close),
    inner: text.slice(close + 2, end),
  };
}

function matching(
  text: string,
  from: number,
  limit: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = from; index < limit; index += 1) {
    const char = text[index];
    if (char === '\\') index += 1;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index;
  }
  return -1;
}

// A line of nothing but links (and bullets, numbers, emoji) becomes a preview
// card the app fetches. Such a line with an unvouched address joins the line
// before it, or names its host when there is none. A line is held while it
// may still turn out to be one, and its line break until the next line shows
// whether it stays.
class OwnLineLinks {
  private rest = '';
  private breaks = '';
  private open = false;
  private wrote = false;
  private waiting = false;

  constructor(private readonly seen: (url: string) => boolean) {}

  take(text: string, final: boolean): string {
    this.rest += text;
    let out = '';
    while (final || !this.waiting) {
      const end = this.rest.indexOf('\n');
      if (end < 0 && !final) {
        this.open ||= lettersBeforeLinks(this.rest);
        if (this.open && this.rest) {
          out += this.breaks + this.rest;
          this.breaks = '';
          this.rest = '';
          this.wrote = true;
        }
        return out;
      }
      const line = end < 0 ? this.rest : this.rest.slice(0, end);
      if (this.open) {
        out += line;
      } else {
        const decided = this.line(line, final);
        if (decided === null) {
          this.waiting = true;
          return out;
        }
        out += decided;
      }
      this.open = false;
      if (end < 0) {
        out += this.breaks;
        this.breaks = '';
        this.rest = '';
        this.wrote = false;
        this.waiting = false;
        return out;
      }
      this.rest = this.rest.slice(end + 1);
      this.breaks += '\n';
    }
    return out;
  }

  private line(line: string, final: boolean): string | null {
    if (!line.trim()) {
      this.breaks += line;
      return '';
    }
    const unvouched = this.unvouched(line);
    if (unvouched && !final) return null;
    let out: string;
    if (!unvouched) out = this.breaks + line;
    else if (this.wrote) out = ` ${line}`;
    else out = `${this.breaks}${line} (${hostWords(unvouched)})`;
    this.breaks = '';
    this.wrote = true;
    return out;
  }

  // The first address on a line of nothing but links that no source vouched for.
  private unvouched(line: string): string | null {
    const targets: string[] = [];
    let outside = '';
    let from = 0;
    for (const match of line.matchAll(LINE_LINK_RE)) {
      outside += line.slice(from, match.index);
      from = match.index + match[0].length;
      // A picture was checked as one already.
      if (line[match.index - 1] === '!') continue;
      let target = match[1] ?? match[2] ?? match[3] ?? '';
      if (match[3]) target = target.replace(/[.,;:!?'"*_)]+$/, '');
      if (/^https?:\/\//i.test(target)) targets.push(target);
    }
    outside += line.slice(from);
    if (LETTER_RE.test(outside)) return null;
    return targets.find((target) => !this.seen(target)) ?? null;
  }
}

// Words before a line's first link keep it a sentence whatever follows. A
// trailing `h`, `ht`… may still begin an address.
function lettersBeforeLinks(line: string): boolean {
  const start = line.search(/\[|<|https?:/i);
  const before =
    start < 0
      ? line.replace(/h(?:t(?:t(?:ps?)?)?)?$/i, '')
      : line.slice(0, start);
  return LETTER_RE.test(before);
}

// Letters, so the line reads as a sentence to the app.
function hostWords(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (LETTER_RE.test(host)) return host;
  } catch {
    // Not an address `URL` reads; the app may still.
  }
  return 'web';
}

// Tool results quote addresses as JSON or HTML; the model writes them plain.
function readableForms(text: string, decodePercent = false): string[] {
  const forms = [text];
  // One pass each, so a decoded `\` or `&` never starts another escape.
  const json = text.replace(/\\(?:u([0-9a-fA-F]{4})|\/)/g, (_, hex) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : '/',
  );
  const html = json.replace(
    /&(amp|quot|#39|lt|gt);/g,
    (_, name: string) => HTML_ENTITIES[name],
  );
  forms.push(json, html);
  if (decodePercent) {
    try {
      forms.push(decodeURIComponent(html));
    } catch {
      // Not percent-encoded text.
    }
  }
  return [...new Set(forms)];
}

// Each address as written, and without the punctuation that ends a sentence
// or closes a Markdown link around it.
function urlsIn(text: string): Set<string> {
  const urls = new Set<string>();
  for (const form of readableForms(text)) {
    for (const [run] of form.matchAll(URL_RE)) {
      urls.add(run);
      let end = run.length;
      while (end > 0) {
        const char = run[end - 1];
        const head = run.slice(0, end - 1);
        const unpaired =
          (char === ')' && !head.includes('(')) ||
          (char === ']' && !head.includes('['));
        if (!unpaired && !'.,;:!?*_\'"'.includes(char)) break;
        end -= 1;
      }
      urls.add(run.slice(0, end));
    }
  }
  return urls;
}

function isJsonObject(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null;
  } catch {
    return false;
  }
}
