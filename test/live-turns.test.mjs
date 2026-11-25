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

test('revises live preview without submitting or repeating unconfirmed speech', () => {
  const turns = new TranscriptTurns();
  const results = (start, duration, transcript, is_final = false) => ({
    type: 'Results', start, duration, is_final, channel: { alternatives: [{ transcript }] },
  });

  turns.push(results(0, 1, '你好会议助手，今天'));
  assert.match(turns.preview(), /今天$/);
  assert.equal(turns.preview(false), '');
  turns.push(results(0, 1.4, '你好会议助手，刚才定了'));
  assert.match(turns.preview(), /刚才定了$/);
  assert.equal(turns.finish(), null);
  assert.equal(turns.preview(), '');

  turns.push(results(2, 1, '你好会议助手', true));
  turns.push(results(2, 0.8, '你好会议'));
  assert.equal(turns.preview(), '你好会议助手');
  turns.push(results(3, 1, '什么时候上线'));
  assert.equal(readLiveTurn(turns.preview()).question, '什么时候上线');
  assert.equal(turns.preview(false), '你好会议助手');
  turns.push(results(3, 1.5, '什么时候启动试点', true));
  assert.equal(readLiveTurn(turns.finish().text).question, '什么时候启动试点');
  assert.equal(turns.preview(), '');
});
