/**
 * Each caller utterance can supply consent to at most one consult. The voice
 * model's tool arguments never substitute for a missing or stale transcript.
 * A later utterance invalidates an outstanding read; this is not chat history.
 */
export class ApprovalTranscript {
  private current: {
    id: string;
    text: string | null;
    consumed: boolean;
  } | null = null;
  private waiting: ((text: string | null) => void) | null = null;

  begin(id: string): void {
    this.waiting?.(null);
    this.current = id ? { id, text: null, consumed: false } : null;
  }

  complete(id: string, text: string): void {
    if (!id) return;
    if (!this.current) this.begin(id);
    if (this.current?.id !== id || this.current.consumed) return;
    this.current.text = text;
    this.waiting?.(text);
  }

  async take(): Promise<string | null> {
    const utterance = this.current;
    if (!utterance || utterance.consumed || this.waiting) return null;
    if (utterance.text !== null) {
      utterance.consumed = true;
      return utterance.text;
    }
    return new Promise((resolve) => {
      // STT can finish after the voice model's tool call. Bound this wait to
      // two seconds; missing speech fails closed instead of trusting a paraphrase.
      const timer = setTimeout(() => finish(null), 2_000);
      const finish = (text: string | null) => {
        clearTimeout(timer);
        this.waiting = null;
        utterance.consumed = true;
        resolve(text);
      };
      this.waiting = finish;
    });
  }

  close(): void {
    this.waiting?.(null);
    this.current = null;
  }
}
