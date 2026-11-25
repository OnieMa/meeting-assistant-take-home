import { liveLimits } from '../shared/live';
import type { ReplyLanguage, SignedReply } from '../shared/live';
import { addLiveContext, readLiveTurn, TranscriptTurns } from './live-turns';
import type { TranscriptResult } from './live-turns';

const labels = {
  en: {
    heading: 'Live AI assistant', connecting: 'Connecting to live transcription…',
    ready: 'Listening to the meeting', offline: 'Live connection disconnected. Your recording is still running.',
    expired: 'Live assistant time ended. Your recording is still running.',
    live_quota: 'Live assistance reached its usage limit. Your recording is still running.',
    live_question_limit: 'This recording has reached the eight-question limit.',
    live_expired: 'Live assistance reached its time limit.',
    live_unavailable: 'Live assistance is temporarily unavailable.',
    live_answer_failed: 'The assistant could not answer. Try asking again.',
    live_speech_failed: 'Cloud speech is unavailable. The text answer is ready.',
    ask: 'Ask AI', reconnect: 'Reconnect', listening: 'Or type a question',
    awake: 'Awake · Listening to your question', checkingWake: 'Detecting wake phrase…', awaitingSpeech: 'Your words will appear here as you speak.',
    heard: 'Your question', thinking: 'Preparing your answer…', send: 'Send', cancel: 'Cancel question', field: 'Your question',
    placeholder: 'What did we agree on?', meeting: 'From the meeting', suggestion: 'AI suggestion',
    audioWait: 'Preparing cloud audio…', play: 'Play reply', stop: 'Stop audio',
    wake: 'Say “Hey meeting assistant” or “你好，会议助手”.',
  },
  zh: {
    heading: '实时 AI 助手', connecting: '正在连接实时转写…',
    ready: '正在跟进会议', offline: '实时连接已断开，普通录音仍在继续。',
    expired: '实时助手已达到时长上限，普通录音仍在继续。',
    live_quota: '实时助手已达到使用额度，普通录音仍在继续。',
    live_question_limit: '本次录音已达到 8 次提问上限。',
    live_expired: '实时助手已达到时长上限。',
    live_unavailable: '实时助手暂不可用。',
    live_answer_failed: '助手未能回答，请重试提问。',
    live_speech_failed: '云端朗读暂不可用，文字回复已生成。',
    ask: '问 AI', reconnect: '重新连接', listening: '也可以输入问题',
    awake: '已唤醒 · 正在听你的问题', checkingWake: '正在识别唤醒词…', awaitingSpeech: '你说的话会实时显示在这里。',
    heard: '你问了', thinking: '正在准备回复…', send: '发送', cancel: '取消提问', field: '你的问题',
    placeholder: '刚才确定了什么？', meeting: '会议中已提到', suggestion: 'AI 建议',
    audioWait: '正在生成云端语音…', play: '播放回复', stop: '停止朗读',
    wake: '说「你好，会议助手」或 “Hey meeting assistant”。',
  },
};

type Status = 'connecting' | 'ready' | 'offline' | 'expired';
const keepAlive = '{"type":"KeepAlive"}';
const escape = (value: string) => value.replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export class LiveAssistant {
  private panel = document.createElement('section');
  private locale: ReplyLanguage = 'en';
  private status: Status = 'connecting';
  private session?: { id: string; expiresAt: number };
  private audioContext?: AudioContext;
  private workletReady = false;
  private socket?: WebSocket;
  private connectionAttempt = 0;
  private device?: MediaStream;
  private recorderStart = 0;
  private streamOffset = 0;
  private abort = new AbortController();
  private destroyed = false;
  private listening = false;
  private asking = false;
  private makingAudio = false;
  private question = '';
  private spokenPreview = '';
  private wakePreview = false;
  private submittedQuestion = '';
  private alert = '';
  private reply?: SignedReply;
  private player = new Audio();
  private audioUrl = '';
  private playing = false;
  private context = '';
  private turns = new TranscriptTurns();
  private finalizeTimer?: number;
  private questionTimer?: number;
  private expiryTimer?: number;
  private keepAliveTimer?: number;
  private sentAudioAt = 0;

  constructor() {
    this.panel.className = 'live-panel card';
    this.panel.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.live;
      if (action === 'ask') this.listen();
      if (action === 'reconnect') void this.connect();
      if (action === 'cancel') this.cancelQuestion();
      if (action === 'play') void this.play(false);
      if (action === 'stop') this.player.pause();
    });
    this.panel.addEventListener('input', (event) => {
      this.question = (event.target as HTMLInputElement).value;
    });
    this.panel.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.ask(this.question);
    });
    this.player.addEventListener('play', () => { this.playing = true; this.draw(); });
    for (const event of ['pause', 'ended']) {
      this.player.addEventListener(event, () => { this.playing = false; this.draw(); });
    }
  }

  mount(slot: HTMLElement, locale: ReplyLanguage) {
    slot.appendChild(this.panel);
    this.locale = locale;
    this.draw();
  }

  async start(stream: MediaStream, recorderStart: number) {
    this.device = stream;
    this.recorderStart = recorderStart;
    await this.connect();
  }

  private async request(path: string, body?: unknown) {
    const response = await fetch('/api/live' + path, {
      method: 'POST', signal: this.abort.signal,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
    if (!response.ok) {
      const detail = await response.json<{ error?: string }>().catch(() => ({} as { error?: string }));
      throw new Error(detail.error ?? 'live_unavailable');
    }
    return response;
  }

  private async connect() {
    if (this.destroyed || this.socket || !this.device) return;
    const attempt = ++this.connectionAttempt;
    this.status = 'connecting';
    this.alert = '';
    this.draw();
    try {
      if (!this.audioContext) {
        const context = new AudioContext({ sampleRate: 16_000 });
        this.audioContext = context;
        await context.resume();
        await context.audioWorklet.addModule('/live-pcm.js');
        if (this.destroyed) return;
        const input = context.createMediaStreamSource(this.device);
        const encoder = new AudioWorkletNode(context, 'meeting-pcm');
        const muted = context.createGain();
        muted.gain.value = 0;
        input.connect(encoder).connect(muted).connect(context.destination);
        encoder.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => this.sendAudio(data);
        this.workletReady = true;
      }
      this.session ??= await (await this.request('')).json<{ id: string; expiresAt: number }>();
      if (this.destroyed || attempt !== this.connectionAttempt) return;
      const remaining = this.session.expiresAt - Date.now();
      if (remaining <= 0) {
        this.expire();
        return;
      }
      window.clearTimeout(this.expiryTimer);
      this.expiryTimer = window.setTimeout(() => this.expire(), remaining);
      const url = new URL('/api/live/' + this.session.id + '/stream', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('rate', String(this.audioContext.sampleRate));
      const socket = new WebSocket(url);
      this.socket = socket;
      this.turns.reset();
      socket.onopen = () => {
        if (this.socket !== socket || this.destroyed) return;
        this.streamOffset = (Date.now() - this.recorderStart) / 1000;
        this.status = 'ready';
        this.sentAudioAt = Date.now();
        this.keepAliveTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN && Date.now() - this.sentAudioAt >= 3000) socket.send(keepAlive);
        }, 4000);
        this.draw();
      };
      socket.onmessage = (event) => {
        if (this.socket === socket && typeof event.data === 'string') this.receive(event.data);
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        window.clearInterval(this.keepAliveTimer);
        this.status = event.code === 4001 ? 'expired' : 'offline';
        this.flushTurn();
        this.cancelQuestion();
      };
    } catch (reason) {
      if (this.destroyed) return;
      if (!this.workletReady && this.audioContext) {
        void this.audioContext.close().catch(() => {});
        this.audioContext = undefined;
      }
      this.status = 'offline';
      this.alert = reason instanceof Error ? reason.message : 'live_unavailable';
      this.draw();
    }
  }

  private sendAudio(data: ArrayBuffer) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 256_000) {
      this.socket.close();
      return;
    }
    this.socket.send(this.playing ? new ArrayBuffer(data.byteLength) : data);
    this.sentAudioAt = Date.now();
  }

  private receive(message: string) {
    try {
      const result: TranscriptResult = JSON.parse(message);
      const ended = this.turns.push(result);
      if (ended) {
        this.flushTurn();
        return;
      }
      if (result.type !== 'Results') return;
      this.updateSpeechPreview();
      if (this.turns.pending && (result.is_final || result.channel?.alternatives?.[0]?.transcript?.trim())) {
        window.clearTimeout(this.finalizeTimer);
        this.finalizeTimer = window.setTimeout(() => this.flushTurn(), 1600);
      }
    } catch { /* Ignore non-transcript provider messages. */ }
  }

  private updateSpeechPreview() {
    const parsed = readLiveTurn(this.turns.preview());
    const canWake = this.status === 'ready' && !this.asking && !this.playing;
    this.wakePreview = !this.listening && canWake && parsed.kind === 'wake';
    this.spokenPreview = this.listening || this.wakePreview
      ? (parsed.kind === 'wake' ? parsed.question : parsed.text).slice(0, liveLimits.question)
      : '';
    if (this.listening && this.spokenPreview) this.resetQuestionTimer();
    this.paintSpeechPreview();
  }

  private paintSpeechPreview() {
    const region = this.panel.querySelector<HTMLElement>('.live-capture');
    const caption = region?.querySelector<HTMLElement>('.live-caption');
    const label = region?.querySelector<HTMLElement>('.live-awake-label');
    if (!region || !caption || !label) return;
    const s = labels[this.locale];
    region.hidden = !(this.listening || this.wakePreview);
    const status = this.listening ? s.awake : s.checkingWake;
    if (label.textContent !== status) label.textContent = status;
    const text = this.spokenPreview || s.awaitingSpeech;
    caption.classList.toggle('live-caption-empty', !this.spokenPreview);
    if (caption.textContent !== text) caption.textContent = text;
  }

  private flushTurn() {
    window.clearTimeout(this.finalizeTimer);
    const turn = this.turns.finish();
    this.wakePreview = false;
    this.spokenPreview = '';
    this.paintSpeechPreview();
    if (!turn) return;
    const parsed = readLiveTurn(turn.text);
    if (this.listening && !this.asking && !this.question.trim()) {
      const question = parsed.kind === 'wake' ? parsed.question : turn.text;
      if (question) void this.ask(question);
      return;
    }
    const meetingText = parsed.kind === 'wake' ? parsed.before : parsed.text;
    this.context = addLiveContext(this.context, turn.start + this.streamOffset, meetingText, liveLimits.context);
    if (parsed.kind === 'wake' && this.status === 'ready' && !this.asking && !this.playing) {
      this.listen();
      if (parsed.question) void this.ask(parsed.question);
    }
  }

  private listen() {
    if (this.asking || this.destroyed || this.status !== 'ready') return;
    if (this.playing) this.player.pause();
    this.flushPendingMeeting();
    this.listening = true;
    this.question = '';
    this.wakePreview = false;
    this.spokenPreview = '';
    this.alert = '';
    this.resetQuestionTimer();
    this.draw();
  }

  private resetQuestionTimer() {
    window.clearTimeout(this.questionTimer);
    this.questionTimer = window.setTimeout(() => {
      if (!this.question) this.cancelQuestion();
    }, 12_000);
  }

  private flushPendingMeeting() {
    window.clearTimeout(this.finalizeTimer);
    const pending = this.turns.finish();
    if (pending) this.context = addLiveContext(this.context, pending.start + this.streamOffset, pending.text, liveLimits.context);
  }

  private cancelQuestion() {
    window.clearTimeout(this.questionTimer);
    this.question = '';
    this.listening = false;
    this.wakePreview = false;
    this.spokenPreview = '';
    this.draw();
  }

  private async ask(rawQuestion: string) {
    const question = rawQuestion.trim().slice(0, liveLimits.question);
    if (!question || this.asking || this.destroyed || !this.session || this.status !== 'ready') return;
    const path = '/' + this.session.id;
    window.clearTimeout(this.questionTimer);
    this.listening = false;
    this.question = '';
    this.wakePreview = false;
    this.spokenPreview = '';
    this.submittedQuestion = question;
    this.asking = true;
    this.alert = '';
    this.clearAudio();
    this.reply = undefined;
    this.draw();
    try {
      const answer = await this.request(path + '/ask', { question, context: this.context });
      this.reply = await answer.json<SignedReply>();
      if (this.destroyed) return;
      this.makingAudio = true;
      this.draw();
      try {
        const spoken = await this.request(path + '/speech', this.reply);
        const audio = await spoken.blob();
        if (this.destroyed) return;
        this.audioUrl = URL.createObjectURL(audio);
        this.player.src = this.audioUrl;
        void this.play(true);
      } catch {
        this.alert = 'live_speech_failed';
      }
    } catch (reason) {
      this.alert = reason instanceof Error ? reason.message : 'live_answer_failed';
    } finally {
      this.asking = false;
      this.makingAudio = false;
      this.draw();
    }
  }

  private async play(automatic: boolean) {
    if (!this.audioUrl || this.destroyed) return;
    if (this.player.ended) this.player.currentTime = 0;
    try { await this.player.play(); } catch {
      if (!automatic) this.alert = 'live_speech_failed';
      this.draw();
    }
  }

  private clearAudio() {
    this.player.pause();
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.player.removeAttribute('src');
    this.audioUrl = '';
    this.playing = false;
  }

  private expire() {
    this.status = 'expired';
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    window.clearInterval(this.keepAliveTimer);
    this.cancelQuestion();
  }

  destroy() {
    this.destroyed = true;
    this.abort.abort();
    this.socket?.close();
    this.socket = undefined;
    void this.audioContext?.close().catch(() => {});
    this.clearAudio();
    window.clearTimeout(this.finalizeTimer);
    window.clearTimeout(this.questionTimer);
    window.clearTimeout(this.expiryTimer);
    window.clearInterval(this.keepAliveTimer);
    this.panel.remove();
  }

  private draw() {
    if (this.destroyed) return;
    const s = labels[this.locale];
    const focused = document.activeElement instanceof HTMLInputElement && this.panel.contains(document.activeElement)
      ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
    const alert = s[this.alert as keyof typeof s] ?? s.live_unavailable;
    this.panel.innerHTML = `<div class="live-head"><div><h2>${s.heading}</h2>
      <p class="live-status" role="status">${s[this.status]}</p></div>
      ${this.status === 'ready' ? `<button type="button" class="secondary" data-live="ask" ${this.asking || this.listening ? 'disabled' : ''}>${s.ask}</button>` : ''}
      ${this.status === 'offline' ? `<button type="button" class="secondary" data-live="reconnect">${s.reconnect}</button>` : ''}
      </div>
      ${this.status === 'ready' && !this.listening ? `<p class="hint">${s.wake}</p>` : ''}
      ${this.alert ? `<p class="live-alert" role="alert">${alert}</p>` : ''}
      <div class="live-capture" hidden>
        <div class="live-awake" role="status"><span class="live-pulse" aria-hidden="true"></span><span class="live-awake-label"></span></div>
        <p class="live-caption" dir="auto"></p>
      </div>
      ${this.listening ? `<form class="live-question"><label for="live-question-input">${s.listening}</label>
        <div><input id="live-question-input" maxlength="${liveLimits.question}" value="${escape(this.question)}" placeholder="${s.placeholder}" aria-label="${s.field}">
        <button class="primary">${s.send}</button><button type="button" class="text-button" data-live="cancel">${s.cancel}</button></div></form>` : ''}
      ${this.submittedQuestion && !this.listening ? `<div class="live-submitted"><strong>${s.heard}</strong>
        <p dir="auto">${escape(this.submittedQuestion)}</p></div>` : ''}
      ${this.asking && !this.reply ? `<p class="live-progress" role="status">${s.thinking}</p>` : ''}
      ${this.reply ? `<div class="live-answer" lang="${this.reply.language}">
        ${this.reply.meeting ? `<h3>${s.meeting}</h3><p>${escape(this.reply.meeting)}</p>` : ''}
        ${this.reply.suggestion ? `<h3>${s.suggestion}</h3><p>${escape(this.reply.suggestion)}</p>` : ''}
        ${this.makingAudio ? `<p class="hint" role="status">${s.audioWait}</p>` : ''}
        ${this.audioUrl ? `<button type="button" class="secondary" data-live="${this.playing ? 'stop' : 'play'}">${this.playing ? s.stop : s.play}</button>` : ''}
      </div>` : ''}`;
    this.paintSpeechPreview();
    if (focused) {
      const input = this.panel.querySelector<HTMLInputElement>('input');
      input?.focus();
      input?.setSelectionRange(focused.start, focused.end);
    }
  }
}
