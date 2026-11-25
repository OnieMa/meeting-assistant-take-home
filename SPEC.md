# Meeting Assistant specification

## Scope

A workspace is identified by a portable access code. A user uploads audio or records it in the browser, then reviews speaker-labeled transcription, original audio and equivalent Chinese and English notes. Core operation targets Cloudflare Workers Free. Live assistance is optional during microphone recordings.

## Acceptance criteria

| ID | Given / when | Expected result |
| --- | --- | --- |
| A1 | A visitor creates a workspace, or opens its access code from a separate session | Creation reveals a random code once. Reusing it opens the same history. A different code cannot read audio, notes or transcripts from this workspace. |
| A2 | A user uploads a supported file up to 95 MB or stops a microphone recording | The app displays upload progress, then a saved processing status. Refreshing or opening another device retains the meeting. Unsupported files or denied microphone permission produce actionable feedback. |
| A3 | Deepgram returns a successful callback for the current attempt | The job saves timestamped, speaker-labeled utterances without loading the whole callback into the HTTP handler. The transcript and audio can be reviewed, with range playback and seeking. Duplicate/stale callbacks do not overwrite results. |
| A4 | The transcript is available | Both notes are generated together. They use equivalent facts and include only supported summaries, topics, confirmed decisions, actions and questions. Owners and deadlines are optional. Opinions and proposals retain their status. |
| A5 | A user saves an edit in either language | The source and translated notes update together. If translation fails, the stored revision stays intact and the draft is retained. If another session has already saved, the user can review the newer notes before choosing to apply their draft. |
| A6 | A user toggles the interface language or reopens it | Controls and states use the selected language. Both notes remain visible, and the preference persists in this browser. |
| A7 | Processing fails after upload | The failure is visible and the original audio remains playable. Retrying creates a new processing attempt without a second upload. |
| A8 | The deployed Free Worker processes the original ~90-minute test MP3 | It reaches ready, with final timestamp and multiple speakers visible. Verify Workers CPU and Workers AI usage, range playback and cross-device access. This requires live Cloudflare and Deepgram credentials. |
| A9 | A user saves a new meeting without entering a title, or renames any saved meeting | A blank title is replaced by a title based on the generated meeting notes. Explicit titles persist across devices and take precedence over processing. Older titles are preserved during database migration and may be edited or set to a suggested title. |
| A10 | A user enables live assistance during microphone recording | A Chinese or English wake phrase or the Ask AI button accepts a question. The answer uses this recording's transcript, distinguishes suggestions from meeting facts, matches the question's language and has cloud audio. Disconnecting or reaching a limit leaves ordinary recording active. |

## Interfaces and invariants

- All paths below are relative to `/api`. `GET /session` reports session and demo state. `POST /session` accepts `{action:"create"}` or `{action:"open",code}`. `DELETE /session` signs out the current browser. Session tokens and access codes are hashed at rest.
- `GET /meetings` lists workspace meetings. `POST /meetings?title=…` takes the original audio body. `GET /meetings/:id` returns the processing state, note revisions, transcript part count and audio metadata. `POST /meetings/:id/retry` starts a failed meeting again.
- `GET|HEAD /meetings/:id/audio` serves the original MIME type and byte ranges. `GET /meetings/:id/transcript?part=N` returns `{start,end,speaker,text}[]`. `PUT /meetings/:id/notes` takes `{language,text,version}` and returns both updated notes, or 409 for a stale revision.
- `PUT /meetings/:id/title` accepts `{title}` or `{mode:"auto",language}` and returns the updated meeting. A blank upload title opts into automatic naming, with `fallbackTitle` as temporary display text.
- `POST /live` starts an authenticated, bounded live session. `GET /live/:id/stream` upgrades to a WebSocket for live PCM frames and transcription. `POST /live/:id/ask` returns separate facts and suggestions with a signed speech token. `POST /live/:id/speech` generates audio for that reply. Live assistance does not change post-recording processing.
- A Workflow runs each attempt and polls its authenticated Deepgram callback in R2. Attempt IDs scope callbacks and transcript keys. D1 is the source of truth for status and note revision. Job-specific authorization protects provider reads. Keys and tokens stay out of browser code.
- Demo mode substitutes a labeled example transcript and deterministic notes/synchronization to test the application plumbing. It uses the same Worker, Workflow and storage interfaces as production.

## Implementation and verification order

1. Define API, state transitions and storage. Verify request isolation, upload and playback boundaries.
2. Implement Workflow and provider handoff. Exercise the callback parser with a multibyte fixture across read windows.
3. Build the browser UI. Walk through workspace creation and reopening, upload/microphone, transcript/playback, edits in both directions, conflict handling and locale switching.
4. Run the type check and production build. Run the live acceptance test separately when the provider credentials are available.
