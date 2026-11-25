const wake = /你\s*好[\s，,。！!、]*会\s*议\s*助\s*手|\bhey[\s,!.]+meeting[\s,!.]+assistant\b/iu;
const leadingPunctuation = /^[\s，,。.!！、：:？?]+/u;

export type Turn =
  | { kind: 'meeting'; text: string }
  | { kind: 'wake'; before: string; question: string };

export function readLiveTurn(text: string): Turn {
  const match = wake.exec(text);
  if (!match) return { kind: 'meeting', text: text.trim() };
  return {
    kind: 'wake',
    before: text.slice(0, match.index).trim(),
    question: text.slice(match.index + match[0].length).replace(leadingPunctuation, '').trim(),
  };
}

export interface TranscriptResult {
  type?: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

export class TranscriptTurns {
  private seen = new Set<string>();
  private sections: { start: number; text: string }[] = [];
  private interim = '';
  private finalizedThrough = 0;

  push(result: TranscriptResult): boolean {
    if (result.type === 'UtteranceEnd') return this.sections.length > 0;
    if (result.type !== 'Results') return false;
    const text = result.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
    const start = result.start;
    const duration = result.duration;
    if (typeof start === 'number' && typeof duration === 'number' && Number.isFinite(start) && Number.isFinite(duration)) {
      if (result.is_final) {
        const key = start + ':' + duration;
        if (!this.seen.has(key)) {
          this.seen.add(key);
          this.finalizedThrough = Math.max(this.finalizedThrough, start + duration);
          this.interim = '';
          if (text) this.sections.push({ start, text });
        }
      } else if (start >= this.finalizedThrough - 0.06) {
        this.interim = text;
      }
    }
    return this.sections.length > 0 && result.speech_final === true;
  }

  get pending() { return this.sections.length > 0; }

  preview() {
    return [...this.sections.map(({ text }) => text), this.interim].filter(Boolean).join(' ');
  }

  finish() {
    this.interim = '';
    const first = this.sections[0];
    if (!first) return null;
    const text = this.sections.map((section) => section.text).join(' ');
    this.sections = [];
    return { start: first.start, text };
  }

  reset() {
    this.sections = [];
    this.seen.clear();
    this.interim = '';
    this.finalizedThrough = 0;
  }
}

export function addLiveContext(context: string, start: number, text: string, limit: number) {
  if (!text) return context;
  const seconds = Math.max(0, Math.floor(start));
  const stamp = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const line = '[' + stamp + '] ' + text;
  const combined = context ? context + '\n' + line : line;
  if (combined.length <= limit) return combined;
  const marker = '[Earlier transcript truncated]\n';
  const tail = combined.slice(-(limit - marker.length));
  const nextLine = tail.indexOf('\n');
  return marker + (nextLine >= 0 ? tail.slice(nextLine + 1) : tail);
}
