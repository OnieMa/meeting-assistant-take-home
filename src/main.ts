import './style.css';
import { en, zh } from './strings';

type Lang = 'en' | 'zh';
type State = 'queued' | 'transcribing' | 'writing' | 'ready' | 'failed';
interface Meeting {
  id: string;
  title: string;
  createdAt: number;
  duration: number | null;
  state: State;
  error: string | null;
  transcriptParts?: number;
  version?: number;
  notes?: Record<Lang, string | null>;
}
interface Line { start: number; end: number; speaker: number; text: string }
interface Draft { language: Lang; text: string; version: number; conflict: boolean; latest?: string }

const app = document.querySelector<HTMLDivElement>('#app')!;
const base = '/api';
const accepted = 'audio/*,.mp3,.wav,.m4a,.ogg,.webm,.aac,.flac,.mp4';
const extensions: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  webm: 'audio/webm', aac: 'audio/aac', flac: 'audio/flac', mp4: 'audio/mp4',
};

let language: Lang = localStorage.getItem('meeting-language') === 'zh' ? 'zh' : 'en';
let active = false;
let initialized = false;
let demo = false;
let authBusy = false;
let meetings: Meeting[] = [];
let current: Meeting | null = null;
let epoch = 0;
let selection = 0;
let newCode = '';
let copied = false;
let codeInput = '';
let titleInput = '';
let error = '';
let notice = '';
let uploading = false;
let uploadingPct = 0;
let micPending = false;
let recorder: MediaRecorder | null = null;
let recordingStarted = 0;
let saving = false;
let retrying = false;
let draft: Draft | null = null;
let transcript: Line[] = [];
let nextPart = 0;
let reading = false;

const t = () => language === 'zh' ? zh : en;
const esc = (value: string | number) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const detailUrl = (id: string) => '/meetings/' + id;
const date = (value: number) => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en',
  { dateStyle: 'medium', timeStyle: 'short' }).format(value);
const time = (value: number) => [Math.floor(value / 60), Math.floor(value % 60)]
  .map((part) => String(part).padStart(2, '0')).join(':');

function message(code: string) {
  if (/^deepgram_http_\d+$/.test(code)) return t().transcription_provider;
  return t()[code as keyof typeof en] ?? t().server_error;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
  } catch {
    throw new Error('network');
  }
  if (!response.ok) {
    const result = await response.json<{ error?: string }>().catch(() => ({ error: 'server_error' }));
    throw new Error(result.error || 'server_error');
  }
  return response.json();
}

function fail(cause: unknown) {
  const code = cause instanceof Error ? cause.message : 'server_error';
  if (code === 'no_session') resetWorkspace();
  error = code;
}

function resetWorkspace() {
  epoch++;
  selection++;
  active = false;
  newCode = '';
  copied = false;
  meetings = [];
  current = null;
  draft = null;
  reading = false;
  transcript = [];
  nextPart = 0;
  codeInput = '';
  titleInput = '';
  notice = '';
}

function wave() {
  return '<span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>';
}

function statusBadge(state: State) {
  return `<span class="status status-${state}"><i></i>${t()[state]}</span>`;
}

function sidebar() {
  const s = t();
  return `<aside class="sidebar">
    <div class="sidebar-head"><h2>${s.workspace}</h2>${active ? `<button class="new" data-action="new" ${uploading || recorder || micPending || saving ? 'disabled' : ''}><b aria-hidden="true">+</b>${s.newMeeting}</button>` : ''}</div>
    <h3>${s.history}</h3>
    ${meetings.length ? `<nav class="history" aria-label="${s.history}">${meetings.map((meeting) =>
      `<button class="history-item" data-meeting="${meeting.id}" ${current?.id === meeting.id ? 'aria-current="true"' : ''} ${uploading || recorder || micPending || saving ? 'disabled' : ''}>
        <span class="history-name">${esc(meeting.title)}</span><span class="history-date">${date(meeting.createdAt)}</span>
        <i class="history-state status-${meeting.state}" title="${s[meeting.state]}"></i></button>`,
    ).join('')}</nav>` : `<p class="history-empty">${active ? s.emptyHistory : s.noWorkspace}</p>`}
    <div class="sidebar-foot"><span class="shield" aria-hidden="true">◇</span>${s.secure}</div>
  </aside>`;
}

function gate() {
  const s = t();
  if (!initialized) return `<p class="loading" role="status">${s.loading}</p>`;
  return `<section class="welcome card">
    <span class="tile welcome-tile" aria-hidden="true">${wave()}</span>
    <h1>${s.welcome}</h1><p>${s.welcomeBody}</p>
    <form id="join-form">
      <label for="code-input">${s.code}</label>
      <input id="code-input" name="code" value="${esc(codeInput)}" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required maxlength="35" autocomplete="off" spellcheck="false">
      <button type="submit" class="primary" ${authBusy ? 'disabled' : ''}>${s.open}</button>
    </form>
    <div class="welcome-foot"><span>${s.startFresh}</span> <button data-action="create" class="text-button" ${authBusy ? 'disabled' : ''}>${s.create}</button></div>
  </section>`;
}

function accessNotice() {
  if (!newCode) return '';
  const s = t();
  return `<section class="code-banner">
    <div><strong>${s.savedCode}</strong><p>${s.savedCodeBody}</p><code>${esc(newCode)}</code></div>
    <div class="code-actions"><button class="secondary" data-action="copy">${copied ? s.copied : s.copy}</button>
      <button class="text-button" data-action="dismiss">${s.done}</button></div>
  </section>`;
}

function composer() {
  const s = t();
  const disabled = uploading || recorder || micPending ? 'disabled' : '';
  return `<section class="composer">
    <h1>${s.addAudio}</h1><p class="lede">${s.addAudioBody}</p>
    <div class="title-field"><label for="meeting-title">${s.title} <span>${s.optional}</span></label>
    <input id="meeting-title" maxlength="120" placeholder="${s.titlePlaceholder}" value="${esc(titleInput)}"></div>
    <div class="sources">
      <section class="source card" id="dropzone">
        <span class="tile" aria-hidden="true">⇧</span>
        <h2>${s.upload}</h2><p>${s.uploadHelp}</p>
        <button data-action="file" class="primary" ${disabled}>${s.choose}</button>
        <span class="drop-hint">${s.drop}</span>
        <input type="file" id="audio-file" accept="${accepted}" hidden ${disabled}>
      </section>
      <section class="source card">
        <span class="tile recording-tile" aria-hidden="true">${wave()}</span>
        <h2>${s.record}</h2><p>${s.recordHelp}</p>
        ${recorder
          ? `<button class="danger" data-action="stop">${s.stop}</button><span class="recording-status">● ${s.recording} <time id="record-clock">${time((Date.now() - recordingStarted) / 1000)}</time></span>`
          : `<button class="secondary" data-action="record" ${disabled}>${s.start}</button>`}
      </section>
    </div>
    ${uploading ? `<div class="upload-progress" role="status"><span>${s.uploading} <span id="upload-percent">${uploadingPct}%</span></span>
      <progress id="upload-progress" max="100" value="${uploadingPct}" aria-label="${s.uploading}"></progress></div>` : ''}
  </section>`;
}

function notesMarkup(value: string) {
  return value.split('\n').map((line) => {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) return `<h4>${esc(heading[1])}</h4>`;
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (item) return `<p class="notes-item">${esc(item[1])}</p>`;
    return line.trim() ? `<p>${esc(line)}</p>` : '';
  }).join('');
}

function notePanel(meeting: Meeting, key: Lang) {
  const s = t();
  const value = meeting.notes?.[key];
  const label = key === 'zh' ? s.zh : s.english;
  const editing = draft?.language === key ? draft : null;
  return `<article class="note card" lang="${key}">
    <div class="note-head"><h3>${label}</h3>${value && !draft ? `<button class="text-button" data-edit="${key}" aria-label="${s.edit} ${label}">${s.edit}</button>` : ''}</div>
    ${editing ? `<form id="notes-form">
      ${editing.latest ? `<details class="latest-notes" open><summary>${s.latest}</summary><div class="notes-content">${notesMarkup(editing.latest)}</div></details>` : ''}
      <textarea id="note-text" maxlength="12000" required ${saving ? 'disabled' : ''} aria-label="${label}">${esc(editing.text)}</textarea>
      <p class="hint">${s.editHelp}</p>
      <div class="edit-actions">
        <button class="primary" ${saving || editing.conflict ? 'disabled' : ''}>${saving ? s.saving : s.save}</button>
        <button type="button" class="text-button" data-action="cancel-edit" ${saving ? 'disabled' : ''}>${s.cancel}</button>
      </div>
      ${editing.conflict ? `<button type="button" class="text-button conflict-action" data-action="reload-notes">${s.reload}</button>` : ''}
      </form>` : value ? `<div class="notes-content">${notesMarkup(value)}</div>` : `<p class="hint">${s.noNotes}</p>`}
  </article>`;
}

function details(meeting: Meeting) {
  const s = t();
  return `<section class="detail">
    <div class="detail-head"><div><p class="detail-date">${date(meeting.createdAt)}</p><h1>${esc(meeting.title)}</h1></div>${statusBadge(meeting.state)}</div>
    ${meeting.state === 'failed' ? `<div class="processing"><p>${message(meeting.error ?? 'processing_failed')}</p><button data-action="retry" class="secondary" ${retrying ? 'disabled' : ''}>${s.retry}</button></div>` : meeting.state !== 'ready' ? `<p class="processing">${s.wait}</p>` : ''}
    <section class="playback card"><div><h2>${s.playback}</h2></div>
      <audio id="player" controls preload="metadata" src="${base + detailUrl(meeting.id)}/audio" aria-label="${s.playback}"></audio></section>
    <h2 class="section-title">${s.notes}</h2>
    <div class="notes">${notePanel(meeting, 'zh')}${notePanel(meeting, 'en')}</div>
    <h2 class="section-title">${s.transcript}</h2>
    <section class="transcript card">
      ${transcript.map((entry) => `<div class="utterance">
        <button class="timecode" data-seek="${entry.start}" aria-label="${s.playback} ${time(entry.start)}">${time(entry.start)}</button>
        <div><strong class="speaker speaker-${entry.speaker % 3}">${s.speaker} ${entry.speaker + 1}</strong><p>${esc(entry.text)}</p></div>
      </div>`).join('')}
      ${!meeting.transcriptParts ? `<p class="hint">${s.noTranscript}</p>` : ''}
      ${nextPart < (meeting.transcriptParts ?? 0) ? `<button data-action="transcript" class="secondary" ${reading ? 'disabled' : ''}>${nextPart ? s.more : s.loadTranscript}</button>` : ''}
    </section>
  </section>`;
}

function render(focusId?: string) {
  const oldPlayer = app.querySelector<HTMLAudioElement>('#player');
  const oldSrc = oldPlayer?.getAttribute('src');
  const oldTime = oldPlayer?.currentTime ?? 0;
  const wasPlaying = oldPlayer && !oldPlayer.paused && !oldPlayer.ended;
  const s = t();
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = s.brand;
  app.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">${wave()}</span><span>${s.brand}</span></div>
    <div class="top-actions">${active ? `<button class="text-button switch" data-action="signout" ${uploading || recorder || micPending || saving ? 'disabled' : ''}>${s.switchWorkspace}</button>` : ''}
      <div class="language" aria-label="Language / 语言"><button data-lang="en" lang="en" aria-pressed="${language === 'en'}">EN</button><button data-lang="zh" lang="zh" aria-pressed="${language === 'zh'}">中文</button></div>
    </div></header>
    <div class="layout">${sidebar()}<main id="workspace" class="main ${active ? '' : 'guest'}">
      ${demo ? `<div class="demo">${s.demo}</div>` : ''}
      ${accessNotice()}
      ${error ? `<div class="alert" role="alert">${message(error)}</div>` : notice ? `<div class="success" role="status">${message(notice)}</div>` : ''}
      ${active ? current ? details(current) : composer() : gate()}
    </main></div>`;
  const player = app.querySelector<HTMLAudioElement>('#player');
  if (player && player.getAttribute('src') === oldSrc && (oldTime || wasPlaying)) {
    player.currentTime = oldTime;
    if (wasPlaying) void player.play().catch(() => {});
  }
  if (focusId) app.querySelector<HTMLElement>(focusId)?.focus();
}

async function refreshHistory() {
  const version = epoch;
  const list = await api<Meeting[]>('/meetings');
  if (version !== epoch || !active) return false;
  const changed = JSON.stringify(list) !== JSON.stringify(meetings);
  meetings = list;
  return changed;
}

async function authenticate(action: 'create' | 'open') {
  if (authBusy) return;
  authBusy = true;
  error = '';
  render();
  try {
    const result = await api<{ code?: string }>('/session', 'POST', { action, code: codeInput });
    resetWorkspace();
    active = true;
    newCode = result.code ?? '';
    await refreshHistory();
  } catch (cause) {
    fail(cause);
  } finally {
    authBusy = false;
    render(active ? '#meeting-title' : '#code-input');
  }
}

function clearDetail() {
  selection++;
  current = null;
  transcript = [];
  nextPart = 0;
  reading = false;
  draft = null;
  error = '';
  notice = '';
}

async function openMeeting(id: string) {
  clearDetail();
  const version = selection;
  try {
    const meeting = await api<Meeting>(detailUrl(id));
    if (version !== selection) return;
    current = meeting;
    render();
    if (meeting.transcriptParts) await getTranscript();
  } catch (cause) {
    if (version !== selection) return;
    fail(cause);
    render();
  }
}

function sendAudio(blob: Blob, mime: string, title: string) {
  return new Promise<Meeting>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', base + '/meetings?' + new URLSearchParams({ title }));
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', mime);
    xhr.upload.addEventListener('progress', ({ loaded, total }) => {
      if (!total) return;
      uploadingPct = Math.round(loaded / total * 100);
      const progress = app.querySelector<HTMLProgressElement>('#upload-progress');
      const label = app.querySelector('#upload-percent');
      if (progress) progress.value = uploadingPct;
      if (label) label.textContent = uploadingPct + '%';
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 201 && xhr.response?.id) resolve(xhr.response);
      else reject(new Error(xhr.response?.error ?? (xhr.status === 413 ? 'audio_too_large' : 'upload_failed')));
    });
    xhr.addEventListener('error', () => reject(new Error('upload_failed')));
    xhr.addEventListener('abort', () => reject(new Error('upload_failed')));
    xhr.send(blob);
  });
}

async function addAudio(blob: Blob, name: string, mime: string) {
  if (uploading) return;
  error = !blob.size ? 'empty_audio' : blob.size > 95_000_000 ? 'audio_too_large' : !mime ? 'audio_type' : '';
  if (error) {
    render();
    return;
  }
  uploading = true;
  uploadingPct = 0;
  render();
  try {
    const meeting = await sendAudio(blob, mime, titleInput.trim() || name);
    await refreshHistory();
    titleInput = '';
    await openMeeting(meeting.id);
  } catch (cause) {
    fail(cause);
  } finally {
    uploading = false;
    render();
  }
}

function uploadFile(file: File) {
  if (recorder || micPending || uploading) return;
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const mime = /^(audio\/[a-z0-9.+-]+|video\/(webm|mp4|ogg)|application\/ogg)$/i.test(file.type)
    ? file.type : extensions[extension] ?? '';
  void addAudio(file, file.name.replace(/\.[^.]+$/, ''), mime);
}

async function startRecording() {
  if (recorder || uploading || micPending) return;
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    error = 'mic_unsupported';
    render();
    return;
  }
  micPending = true;
  error = '';
  render();
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((format) => MediaRecorder.isTypeSupported(format));
    const instance = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    const chunks: Blob[] = [];
    let bytes = 0;
    let broken = false;
    const stopTracks = () => stream?.getTracks().forEach((track) => track.stop());
    instance.addEventListener('dataavailable', ({ data }) => {
      if (broken || !data.size) return;
      bytes += data.size;
      if (bytes > 95_000_000) {
        broken = true;
        error = 'audio_too_large';
        if (instance.state !== 'inactive') instance.stop();
        return;
      }
      chunks.push(data);
    });
    instance.addEventListener('error', () => {
      broken = true;
      error = 'mic_denied';
      if (instance.state !== 'inactive') instance.stop();
    });
    instance.addEventListener('stop', () => {
      stopTracks();
      recorder = null;
      if (broken) {
        render();
        return;
      }
      const contentType = (instance.mimeType || chunks[0]?.type || 'audio/webm').split(';')[0];
      const name = t().recording + ' · ' + date(recordingStarted);
      void addAudio(new Blob(chunks, { type: contentType }), name, contentType);
    });
    instance.start(1000);
    recorder = instance;
    recordingStarted = Date.now();
  } catch {
    stream?.getTracks().forEach((track) => track.stop());
    error = 'mic_denied';
  } finally {
    micPending = false;
    render();
  }
}

async function getTranscript() {
  if (!current || reading || nextPart >= (current.transcriptParts ?? 0)) return;
  const version = selection;
  reading = true;
  render();
  try {
    const entries = await api<Line[]>(detailUrl(current.id) + '/transcript?part=' + nextPart);
    if (version !== selection) return;
    transcript.push(...entries);
    nextPart++;
  } catch (cause) {
    if (version === selection) fail(cause);
  } finally {
    if (version === selection || !active) {
      reading = false;
      render();
    }
  }
}

async function saveNotes() {
  if (!current || !draft || saving || draft.conflict) return;
  saving = true;
  error = '';
  notice = '';
  render();
  try {
    current = await api<Meeting>(detailUrl(current.id) + '/notes', 'PUT', draft);
    draft = null;
    notice = 'translated';
  } catch (cause) {
    fail(cause);
    if (draft && error === 'version_conflict') draft.conflict = true;
  } finally {
    saving = false;
    render(draft ? '#note-text' : undefined);
  }
}

async function reloadNotes() {
  if (!current || !draft?.conflict) return;
  const previous = draft;
  const version = selection;
  try {
    const meeting = await api<Meeting>(detailUrl(current.id));
    if (version !== selection || previous !== draft) return;
    current = meeting;
    draft.latest = meeting.notes?.[draft.language] ?? undefined;
    draft.version = meeting.version ?? 0;
    draft.conflict = false;
    error = '';
  } catch (cause) {
    if (version === selection) fail(cause);
  }
  render();
}

async function retry() {
  if (!current || retrying) return;
  const version = selection;
  retrying = true;
  error = '';
  render();
  try {
    const meeting = await api<Meeting>(detailUrl(current.id) + '/retry', 'POST');
    if (version !== selection) return;
    current = meeting;
    transcript = [];
    nextPart = 0;
    await refreshHistory();
  } catch (cause) {
    if (version === selection) fail(cause);
  } finally {
    retrying = false;
    render();
  }
}

async function signout() {
  try {
    await api('/session', 'DELETE');
    resetWorkspace();
    error = '';
  } catch (cause) {
    fail(cause);
  }
  render();
}

app.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'code-input') codeInput = input.value;
  if (input.id === 'meeting-title') titleInput = input.value;
  if (input.id === 'note-text' && draft) draft.text = input.value;
});
app.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'audio-file' && input.files?.[0]) uploadFile(input.files[0]);
});
app.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  event.preventDefault();
  if (form.id === 'join-form') void authenticate('open');
  if (form.id === 'notes-form') void saveNotes();
});
app.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button');
  if (!button || button.disabled) return;
  const { action, lang, meeting, edit, seek } = button.dataset;
  if (lang === 'en' || lang === 'zh') {
    language = lang;
    localStorage.setItem('meeting-language', lang);
    render('[data-lang="' + lang + '"]');
  }
  if (meeting) void openMeeting(meeting);
  if ((edit === 'en' || edit === 'zh') && current?.notes?.[edit]) {
    draft = { language: edit, text: current.notes[edit], version: current.version ?? 0, conflict: false };
    error = '';
    notice = '';
    render('#note-text');
  }
  if (seek !== undefined) {
    const player = app.querySelector<HTMLAudioElement>('#player');
    if (player) player.currentTime = Number(seek);
  }
  switch (action) {
    case 'create': void authenticate('create'); break;
    case 'signout': void signout(); break;
    case 'new': clearDetail(); render('#meeting-title'); break;
    case 'dismiss': newCode = ''; copied = false; render(); break;
    case 'copy':
      void (navigator.clipboard?.writeText(newCode) ?? Promise.reject()).then(() => {
        copied = true;
        error = '';
        render();
      }).catch(() => {
        error = 'copyFailed';
        render();
      });
      break;
    case 'file': app.querySelector<HTMLInputElement>('#audio-file')?.click(); break;
    case 'record': void startRecording(); break;
    case 'stop': if (recorder?.state === 'recording') recorder.stop(); break;
    case 'cancel-edit': draft = null; error = ''; render(); break;
    case 'reload-notes': void reloadNotes(); break;
    case 'transcript': void getTranscript(); break;
    case 'retry': void retry(); break;
  }
});
app.addEventListener('dragover', (event) => {
  if (!(event.target as Element).closest('#dropzone')) return;
  event.preventDefault();
  app.querySelector('#dropzone')?.classList.add('dragging');
});
app.addEventListener('dragleave', (event) => {
  const zone = (event.target as Element).closest('#dropzone');
  if (zone && !zone.contains(event.relatedTarget as Node | null)) zone.classList.remove('dragging');
});
app.addEventListener('drop', (event) => {
  if (!(event.target as Element).closest('#dropzone')) return;
  event.preventDefault();
  app.querySelector('#dropzone')?.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) uploadFile(file);
});

let polling = false;
async function poll() {
  if (!active || polling || uploading || recorder || micPending || saving || retrying) return;
  const version = selection;
  const sessionVersion = epoch;
  polling = true;
  try {
    const historyChanged = await refreshHistory();
    if (version !== selection || sessionVersion !== epoch) return;
    if (!current || current.state === 'ready' || current.state === 'failed') {
      if (historyChanged && !draft) render();
      return;
    }
    const meeting = await api<Meeting>(detailUrl(current.id));
    if (version !== selection || sessionVersion !== epoch) return;
    if (meeting.state !== current.state || meeting.transcriptParts !== current.transcriptParts) {
      const first = !current.transcriptParts && !!meeting.transcriptParts;
      current = meeting;
      if (first) await getTranscript();
      else render();
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'no_session' && sessionVersion === epoch) {
      fail(cause);
      render();
    }
  } finally {
    polling = false;
  }
}

setInterval(() => {
  const timer = app.querySelector('#record-clock');
  if (timer && recorder) timer.textContent = time((Date.now() - recordingStarted) / 1000);
}, 250);
setInterval(() => { void poll(); }, 3200);

render();
void (async () => {
  try {
    const session = await api<{ demo: boolean; active: boolean }>('/session');
    demo = session.demo;
    active = session.active;
    if (active) await refreshHistory();
  } catch (cause) {
    fail(cause);
  } finally {
    initialized = true;
    render();
  }
})();
