import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { callbackKey, meetingById, partKey } from './types';
import type { Env, ProcessInput, Segment } from './types';
import { jobProof } from './security';
import { findUtterances, readUtterances } from './transcript';
import type { Cursor } from './transcript';
import { extractNotes, writeNotes } from './notes';

const demoTranscript: Segment[] = [
  { start: 0, end: 3.8, speaker: 0, text: '大家好，今天我们讨论下周的试点。' },
  { start: 4, end: 9.3, speaker: 1, text: 'Let’s start the pilot next week. I’ll send the draft on Friday. — Mei' },
  { start: 9.6, end: 13.1, speaker: 0, text: '同意，下周启动 pilot。' },
];

export class MeetingProcessing extends WorkflowEntrypoint<Env, ProcessInput> {
  async run(event: WorkflowEvent<ProcessInput>, step: WorkflowStep) {
    const { meetingId, attempt } = event.payload;
    const env = this.env;
    const rawKey = callbackKey(attempt);
    try {
      const shouldProcess = await step.do('check job and submit transcription', {
        retries: { limit: 0, delay: '1 second' },
      }, async () => {
        const meeting = await meetingById(env.DB, meetingId);
        if (!meeting || meeting.attempt !== attempt || meeting.state !== 'queued') return false;
        await env.DB.prepare("UPDATE meetings SET state = 'transcribing' WHERE id = ? AND attempt = ?")
          .bind(meetingId, attempt).run();
        if (env.APP_MODE === 'demo') return true;
        if (!env.DEEPGRAM_API_KEY || !env.JOB_SECRET || !env.PUBLIC_ORIGIN) {
          throw new Error('missing_provider_config');
        }

        const expires = Math.floor(Date.now() / 1000) + 3600;
        const audio = new URL(`/api/jobs/${meetingId}/${attempt}/source`, env.PUBLIC_ORIGIN);
        audio.searchParams.set('expires', String(expires));
        audio.searchParams.set('proof', await jobProof(env.JOB_SECRET, `source:${meetingId}:${attempt}:${expires}`));
        const callback = new URL(`/api/jobs/${meetingId}/${attempt}/callback`, env.PUBLIC_ORIGIN);
        callback.username = 'deepgram';
        callback.password = await jobProof(env.JOB_SECRET, `callback:${meetingId}:${attempt}`);
        const provider = new URL('https://api.deepgram.com/v1/listen');
        provider.search = new URLSearchParams({
          model: 'nova-3', language: 'multi', diarize_model: 'latest',
          utterances: 'true', smart_format: 'true', callback: callback.toString(),
        }).toString();
        const response = await fetch(provider, {
          method: 'POST',
          headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: audio.toString() }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`deepgram_http_${response.status}`);
        }
        await response.body?.cancel();
        return true;
      });
      if (!shouldProcess) return;

      let part = 0;
      let duration = 0;
      const groups: { from: number; to: number }[] = [];
      let groupStart = 0;
      let groupLength = 0;

      if (env.APP_MODE === 'demo') {
        await step.do('store example transcript', async () => {
          await env.MEDIA.put(partKey(attempt, 0), JSON.stringify(demoTranscript));
        });
        part = 1;
        duration = demoTranscript.at(-1)!.end;
        groups.push({ from: 0, to: 1 });
      } else {
        let size = 0;
        for (let poll = 0; poll < 75 && !size; poll++) {
          size = await step.do(`check callback ${poll}`, async () => (await env.MEDIA.head(rawKey))?.size ?? 0);
          if (!size) await step.sleep(`wait for callback ${poll}`, poll < 6 ? '10 seconds' : '30 seconds');
        }
        if (!size) throw new Error('transcription_timeout');
        let found = false;
        let offset = 0;
        while (!found && offset < size) {
          const position = offset;
          ({ found, offset } = await step.do(`locate utterances ${position}`,
            () => findUtterances(env.MEDIA, rawKey, position, size)));
        }
        if (!found) throw new Error('no_speech_or_missing_utterances');
        let cursor: Cursor = { offset, start: 0, depth: 0, quoted: false, escape: false, done: false };
        while (!cursor.done) {
          const position: Cursor = cursor;
          const index = part;
          const result = await step.do(`normalize transcript ${position.offset}`, async () => {
            const { next, segments } = await readUtterances(env.MEDIA, rawKey, position, size);
            if (!segments.length) return { next, chars: 0, end: 0 };
            await env.MEDIA.put(partKey(attempt, index), JSON.stringify(segments));
            return {
              next,
              chars: segments.reduce((total, segment) => total + segment.text.length + 24, 0),
              end: segments.at(-1)!.end,
            };
          });
          cursor = result.next;
          if (!result.chars) continue;
          duration = Math.max(duration, result.end);
          if (groupLength && groupLength + result.chars > 9_000) {
            groups.push({ from: groupStart, to: part });
            groupStart = part;
            groupLength = 0;
          }
          groupLength += result.chars;
          part++;
        }
        if (part > groupStart) groups.push({ from: groupStart, to: part });
        if (!part) throw new Error('no_speech_or_missing_utterances');
      }

      await step.do('publish transcript', async () => {
        await env.DB.prepare("UPDATE meetings SET state = 'writing', transcript_parts = ?, duration = ? WHERE id = ? AND attempt = ?")
          .bind(part, duration, meetingId, attempt).run();
      });
      const evidence: string[] = [];
      for (const group of groups) {
        evidence.push(await step.do(`extract evidence ${group.from}`, {
          retries: { limit: 1, delay: '5 seconds' },
        }, async () => {
          const segments: Segment[] = [];
          for (let index = group.from; index < group.to; index++) {
            const object = await env.MEDIA.get(partKey(attempt, index));
            if (!object) throw new Error('missing_transcript_part');
            segments.push(...await object.json<Segment[]>());
          }
          return extractNotes(env, segments);
        }));
      }
      const notes = await step.do('write bilingual meeting notes', {
        retries: { limit: 1, delay: '5 seconds' },
      }, () => writeNotes(env, evidence));
      await step.do('publish notes', async () => {
        await env.DB.prepare("UPDATE meetings SET state = 'ready', notes_zh = ?, notes_en = ?, version = 1 WHERE id = ? AND attempt = ?")
          .bind(notes.zh, notes.en, meetingId, attempt).run();
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      const reason = /^(deepgram_http_\d+|transcription_timeout|no_speech_or_missing_utterances|missing_provider_config)$/
        .test(detail) ? detail : 'processing_failed';
      console.error('meeting processing failed', { meetingId, attempt, reason });
      await step.do('record failure', async () => {
        await env.DB.prepare("UPDATE meetings SET state = 'failed', error = ? WHERE id = ? AND attempt = ?")
          .bind(reason, meetingId, attempt).run();
      });
    }
  }
}
