import assert from 'node:assert/strict';
import test from 'node:test';
import { addLiveContext, readLiveTurn, TranscriptTurns } from '../src/live-turns.ts';

test('recognizes both wake phrases while preserving earlier speech and the question', () => {
  assert.deepEqual(readLiveTurn('已确认周五发布。你好， 会议 助手，刚才说了什么？'), {
    kind: 'wake', before: '已确认周五发布。', question: '刚才说了什么？',
  });
  assert.deepEqual(readLiveTurn('Hey, meeting assistant!'), { kind: 'wake', before: '', question: '' });
  assert.deepEqual(readLiveTurn('They mentioned a meeting assistant.'), {
    kind: 'meeting', text: 'They mentioned a meeting assistant.',
  });
});

test('ignores interim and repeated segments and joins a split wake phrase', () => {
  const turns = new TranscriptTurns();
  const result = (start, transcript, is_final, speech_final = false) => ({
    type: 'Results', start, duration: 0.5, is_final, speech_final, channel: { alternatives: [{ transcript }] },
  });
  assert.equal(turns.push(result(0, 'Hey meeting', false)), false);
  assert.equal(turns.pending, false);
  assert.equal(turns.push(result(0, 'Hey meeting', true)), false);
  assert.equal(turns.push(result(0, 'Hey meeting', true)), false);
  assert.equal(turns.push(result(0.5, 'assistant. What did we agree?', true, true)), true);
  const turn = turns.finish();
  assert.equal(turn.start, 0);
  assert.deepEqual(readLiveTurn(turn.text), { kind: 'wake', before: '', question: 'What did we agree?' });
  assert.equal(turns.finish(), null);
});

test('retains recent timestamped transcript and flags when older discussion was trimmed', () => {
  let context = addLiveContext('', 1.6, '周五上线。', 90);
  context = addLiveContext(context, 65.1, 'We will check the test results tomorrow.', 90);
  context = addLiveContext(context, 72, '负责人还没确定。'.repeat(4), 90);
  context = addLiveContext(context, 82, 'Finalize the schedule.', 90);
  assert.match(context, /^\[Earlier transcript truncated]/);
  assert.match(context, /\[1:22] Finalize the schedule\.$/);
  assert.ok(context.length <= 90);
});
