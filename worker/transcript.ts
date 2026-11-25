import type { Segment } from './types';

const windowSize = 48 * 1024;
const maxUtterance = 512 * 1024;
const decoder = new TextDecoder();
const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;

async function read(bucket: R2Bucket, key: string, offset: number, length: number) {
  if (!length) return new Uint8Array();
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) throw new Error('missing_callback');
  return new Uint8Array(await object.arrayBuffer());
}

export async function findUtterances(bucket: R2Bucket, key: string, offset: number, size: number) {
  const bytes = await read(bucket, key, offset, Math.min(windowSize, size - offset));
  // Latin-1 maps each input byte to a code unit, so regex offsets are byte offsets.
  const match = /"utterances"\s*:\s*\[/.exec(new TextDecoder('latin1').decode(bytes));
  if (match) return { found: true, offset: offset + match.index + match[0].length };
  return {
    found: false,
    offset: offset + bytes.length === size ? size : offset + bytes.length - 64,
  };
}

export interface Cursor {
  offset: number;
  start: number;
  depth: number;
  quoted: boolean;
  escape: boolean;
  done: boolean;
}

interface Utterance {
  start: number;
  end: number;
  speaker?: number;
  transcript: string;
}

export async function readUtterances(bucket: R2Bucket, key: string, cursor: Cursor, size: number) {
  const { offset } = cursor;
  const bytes = await read(bucket, key, offset, Math.min(windowSize, size - offset));
  const next = { ...cursor, offset: offset + bytes.length };
  const segments: Segment[] = [];
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (next.depth === 0) {
      if (byte === 93) {
        next.done = true;
        break;
      }
      if (byte === 44 || whitespace(byte)) continue;
      if (byte !== 123) throw new Error('invalid_utterance_array');
      next.start = offset + index;
      next.depth = 1;
      continue;
    }
    if (next.quoted) {
      if (next.escape) next.escape = false;
      else if (byte === 92) next.escape = true;
      else if (byte === 34) next.quoted = false;
      continue;
    }
    if (byte === 34) next.quoted = true;
    else if (byte === 123 || byte === 91) next.depth++;
    else if (byte === 125 || byte === 93) next.depth--;
    if (next.depth !== 0) continue;

    const length = offset + index + 1 - next.start;
    if (length > maxUtterance) throw new Error('utterance_too_large');
    const utteranceBytes = next.start >= offset
      ? bytes.subarray(next.start - offset, index + 1)
      : await read(bucket, key, next.start, length);
    const entry: Utterance = JSON.parse(decoder.decode(utteranceBytes));
    if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end) ||
        typeof entry.transcript !== 'string') throw new Error('invalid_utterance');
    if (entry.transcript.trim()) {
      segments.push({
        start: entry.start,
        end: entry.end,
        speaker: entry.speaker ?? 0,
        text: entry.transcript.trim(),
      });
    }
  }
  if (next.offset === size && !next.done) throw new Error('incomplete_callback');
  return { next, segments };
}
