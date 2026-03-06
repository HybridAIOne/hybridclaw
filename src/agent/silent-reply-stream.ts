import {
  isSilentReply,
  isSilentReplyPrefix,
  SILENT_REPLY_TOKEN,
} from './silent-reply.js';

function isPotentialStreamPrefix(text: string): boolean {
  if (!text) return false;
  const withoutLeadingWhitespace = text.replace(/^\s+/, '');
  if (!withoutLeadingWhitespace) return true;
  if (withoutLeadingWhitespace.length < 3) {
    return SILENT_REPLY_TOKEN.startsWith(withoutLeadingWhitespace);
  }
  return isSilentReplyPrefix(withoutLeadingWhitespace);
}

export function createSilentReplyStreamFilter(): {
  push: (delta: string) => string;
  flush: () => string;
  isSilent: () => boolean;
} {
  let buffered = '';
  let passthrough = false;
  let silent = false;

  return {
    push(delta: string): string {
      if (!delta) return '';
      if (passthrough) return delta;

      buffered += delta;
      if (isSilentReply(buffered)) return '';
      if (isPotentialStreamPrefix(buffered)) return '';

      const emitted = buffered;
      buffered = '';
      passthrough = true;
      return emitted;
    },
    flush(): string {
      if (!buffered) return '';
      if (isSilentReply(buffered)) {
        buffered = '';
        silent = true;
        return '';
      }

      const emitted = buffered;
      buffered = '';
      passthrough = true;
      return emitted;
    },
    isSilent(): boolean {
      return silent;
    },
  };
}
