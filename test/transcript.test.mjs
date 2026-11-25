import assert from 'node:assert/strict';
import test from 'node:test';
import { findUtterances, readUtterances } from '../worker/transcript.ts';

const windowSize = 48 * 1024;
const utterance = (start, speaker, transcript, padding = '') => ({
  start, end: start + 1, speaker, transcript, words: [{ word: padding }],
});

function callback(prefix, utterances, suffix = '}') {
  const raw = Buffer.from(prefix + utterances + suffix);
  return {
    size: raw.length,
    bucket: {
      async get(_, { range: { offset, length } }) {
        assert.ok(length > 0);
        assert.ok(offset >= 0 && offset + length <= raw.length);
        const bytes = raw.subarray(offset, offset + length);
        return { async arrayBuffer() { return new Uint8Array(bytes).buffer; } };
      },
    },
  };
}

async function normalize({ bucket, size }) {
  let location = { found: false, offset: 0 };
  while (!location.found && location.offset < size) {
    location = await findUtterances(bucket, 'callback', location.offset, size);
  }
  if (!location.found) return null;
  let cursor = { start: 0, depth: 0, quoted: false, escape: false, done: false, offset: location.offset };
  const output = [];
  while (!cursor.done) {
    const { next, segments } = await readUtterances(bucket, 'callback', cursor, size);
    assert.ok(next.offset > cursor.offset);
    cursor = next;
    output.push(...segments);
  }
  return output;
}

test('finds a field split across windows and decodes utterances that span ranges', async () => {
  const beginning = '{"ignore":"';
  const prefix = beginning + 'x'.repeat(windowSize - beginning.length - 7) + '","utterances": [';
  const items = [
    utterance(0, 0, ' 你好，pilot “[开始]” ', '灌'.repeat(35_000)),
    utterance(1, 1, 'A quoted \\ path with "brackets [] {}".'),
    utterance(2, 2, '   '),
    utterance(3, 2, '结束。'),
  ];
  const result = await normalize(callback(prefix, JSON.stringify(items).slice(1)));
  assert.deepEqual(result, [
    { start: 0, end: 1, speaker: 0, text: '你好，pilot “[开始]”' },
    { start: 1, end: 2, speaker: 1, text: 'A quoted \\ path with "brackets [] {}".' },
    { start: 3, end: 4, speaker: 2, text: '结束。' },
  ]);
});

test('does not treat escaped transcript text as the utterance field', async () => {
  const raw = JSON.stringify({ results: { transcript: 'fake "utterances": [ example' } });
  assert.equal(await normalize(callback('', raw, '')), null);
});

test('distinguishes empty utterances from a truncated callback', async () => {
  assert.deepEqual(await normalize(callback('{"utterances":[', ']')), []);
  await assert.rejects(normalize(callback('{"utterances":[', '{"transcript":"broken', '')), /incomplete_callback/);
});
