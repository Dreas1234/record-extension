# MeetRecord — Claude Code Project Context

## What this project is

A Chrome extension (Manifest V3) for **internal company use**. The company owner needs to record meetings and interviews, get transcripts, differentiate speakers, and share those transcripts with participants. This is not a consumer product — it is a single-company internal tool. No multi-tenant auth, no public-facing accounts, no advertising.

---

## Core principles

- **Do not rebuild what exists.** Always read the relevant files before writing anything.
- **Do not modify** `recorder/recorder.js` or `recorder/offscreen.html` unless explicitly told to.
- **Do not modify** the MediaRecorder or offscreen document pipeline unless explicitly told to.
- **Extend, don't replace.** Add new files and functions rather than rewriting existing ones.
- **Match the existing UI style** — dark themed, clean, minimal. See `popup/popup.css` for reference.
- This is an internal tool. Keep UIs functional and professional, not flashy.

---

## Current file structure

```
record-extension/
├── manifest.json                  # MV3 manifest (has: alarms, tabCapture, desktopCapture, storage, https://api.assemblyai.com/*)
├── background.js                  # Service worker — recording orchestrator + transcription pipeline
├── content-scripts/
│   ├── common.js                  # Shared overlay UI
│   ├── meet.js                    # Google Meet detector
│   ├── zoom.js                    # Zoom Web Client detector
│   └── teams.js                   # Microsoft Teams detector
├── popup/
│   ├── popup.html                 # Extension popup
│   ├── popup.css                  # Dark-themed UI styles (reference this for all new UIs)
│   └── popup.js                   # Controls, timer, recordings list
├── recorder/
│   ├── offscreen.html             # Offscreen document host — DO NOT MODIFY
│   └── recorder.js                # MediaRecorder in offscreen context — DO NOT MODIFY
├── storage/
│   └── storage-manager.js         # IndexedDB for recordings + settings
├── transcription/
│   └── assemblyai-client.js       # AssemblyAI API functions
├── utils/
│   ├── platform-detector.js       # URL + DOM platform fingerprinting
│   └── helpers.js                 # formatDuration, waitForElement, etc.
└── icons/
    ├── icon.svg
    └── generate-icons.html
```

---

## What has been built so far

### Prompt 1 — Core recording (COMPLETE)
- Offscreen document + MediaRecorder pipeline
- tabCapture as primary, desktopCapture as fallback
- Background service worker manages recording state across SW sleep/wake using `chrome.storage.session`
- IndexedDB storage via storage-manager.js
- Popup UI with start/stop, timer, recordings list
- Platform detection for Google Meet, Zoom, Teams

### Prompt 2 — Transcription pipeline (COMPLETE)
- `transcription/assemblyai-client.js` with four pure functions: `uploadAudio`, `submitTranscriptionJob`, `fetchTranscriptResult`, `parseUtterances`
- `background.js` extended with: `triggerTranscription`, `registerPendingTranscription`, `pollPendingTranscriptions`
- Polling via `chrome.alarms` (every 1 minute — MV3 minimum)
- Pending jobs stored in `chrome.storage.session` as `{ transcriptId → recordingId }`
- AssemblyAI API key and `speakersExpected` stored in `chrome.storage.local`
- `storage-manager.js` extended with: `updateRecording(id, patches)` and new fields: `status`, `segments`, `transcriptId`

---

## Data formats

### Recording object in IndexedDB
```js
{
  id: "generated-id",
  blob: Blob,              // raw audio (WebM)
  date: Date,
  duration: Number,        // milliseconds
  label: String,           // user-set label, e.g. "Q3 Interview - Sarah"
  meetingTitle: String,    // auto-captured from DOM
  status: "recording" | "processing" | "transcribed",
  transcriptId: String,    // AssemblyAI job ID
  segments: Array,         // transcript segments (see below)
  speakerNames: Object,    // { "Speaker_A": "John", "Speaker_B": "Sarah" }
  tags: Array              // user-applied tags e.g. ["interview", "sales"]
}
```

### Transcript segment format
```js
{
  speaker: "Speaker_A",   // raw label from AssemblyAI
  text: "Hello, welcome.",
  start: 1200,            // milliseconds
  end: 3400,              // milliseconds
  confidence: 0.94
}
```

### Speaker names
After user renames speakers in the viewer, corrected names are stored in `speakerNames` on the recording object. When displaying transcripts, always resolve `segment.speaker` through `speakerNames` first, falling back to the raw label.

---

## Settings stored in chrome.storage.local
```js
{
  assemblyAiApiKey: '',     // set in popup options
  speakersExpected: 2,      // default 2 for interviews, configurable 2–8
  supabaseUrl: '',          // set in popup options (added in Prompt 4)
  supabaseAnonKey: ''       // set in popup options (added in Prompt 4)
}
```

---

## Platforms supported
- Google Meet (`meet.google.com`)
- Zoom Web Client (`zoom.us/wc/`)
- Microsoft Teams (`teams.microsoft.com`)

Meeting title is extracted from the DOM in each content script and sent to `background.js` via `chrome.runtime.sendMessage` when recording starts.

---

## Tech choices (do not change without being told)

| Concern | Solution |
|---|---|
| Transcription + diarization | AssemblyAI (`speaker_labels: true`) |
| Cloud storage / sharing | Supabase (storage bucket + postgres) — added in Prompt 4 |
| PDF export | jsPDF loaded from CDN — added in Prompt 6 |
| Auth | None — single company, no login required |
| Polling | chrome.alarms (1 min interval) |
| State persistence across SW restarts | chrome.storage.session |

---

## What still needs to be built (in order)

### Prompt 3 — Transcript Viewer + Speaker Renaming
- `viewer/viewer.html` and `viewer/viewer.js` as a new tab page
- Opens via "View Transcript" button in popup, passes `?id=RECORDING_ID`
- Displays segments grouped by speaker with timestamps
- Clicking speaker label opens inline rename input
- Renaming one renames all from that speaker
- Saves corrections to IndexedDB via `updateRecording`
- Highlights segments with confidence below 0.80

### Prompt 4 — Cloud Storage + Shareable Links
- `utils/supabase-sync.js`
- Syncs audio blob to Supabase storage bucket "recordings"
- Inserts transcript into "transcripts" postgres table
- Generates public shareable link
- `share/index.html` — standalone page that displays a transcript from a URL param
- "Copy share link" button in popup

### Prompt 5 — Metadata + Dashboard
- Auto-capture meeting title from DOM in each content script
- `dashboard/dashboard.html` and `dashboard/dashboard.js`
- Lists all recordings with label, title, date, duration, speaker names, status
- Inline label editing, search, tag filtering
- Buttons: View Transcript, Copy Share Link, Delete

### Prompt 6 — Export
- Export buttons in transcript viewer
- PDF via jsPDF: company logo placeholder, header info, formatted transcript
- TXT: plain text with speaker names and timestamps
- Audio: download original WebM blob from IndexedDB
- All client-side, no server

---

## Manifest permissions already granted
- `tabCapture`, `desktopCapture`, `storage`, `alarms`, `offscreen`, `notifications`, `activeTab`
- Host permissions: `https://api.assemblyai.com/*`
- Still needed: `https://*.supabase.co/*` (add in Prompt 4)
