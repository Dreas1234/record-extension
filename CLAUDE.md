# MeetRecord — Claude Code Project Context (Updated Architecture)

## What this product is

A two-part system for a company to record interviews, store them, and analyze candidates using AI.

**Part 1 — Chrome Extension**
Employees install it, log in with company credentials, record interviews, and it auto-uploads when done. That's it. Minimal UI.

**Part 2 — Web Dashboard (separate website)**
The whole team logs into a website to see all recordings and transcripts, who uploaded them, and formatted output ready to drop into an AI for candidate scoring and pattern analysis.

**Same login works for both.** AWS Cognito handles authentication across the extension and the web dashboard.

This is an internal tool for one company. Not a consumer product.

---

## Core principles

- Do not rebuild what exists. Always read relevant files before writing anything.
- Do not modify `recorder/recorder.js` or `recorder/offscreen.html` unless explicitly told to.
- Do not modify the MediaRecorder or offscreen document pipeline unless explicitly told to.
- Extend, don't replace. Add new files rather than rewriting working ones.
- Match the existing dark-themed UI style in `popup/popup.css` for the extension.
- The web dashboard should be clean, professional, and readable — not flashy.

---

## Tech stack

| Concern | Solution |
|---|---|
| Recording | Chrome tabCapture + MediaRecorder (already built) |
| Transcription + diarization | AssemblyAI (speaker_labels: true) (already built) |
| File storage | AWS S3 |
| Authentication | AWS Cognito (same credentials for extension + dashboard) |
| Database | Transcript metadata stored as JSON in S3, indexed by recordingId |
| Web dashboard | Standalone HTML/CSS/JS site hosted on S3 or simple hosting |
| AI analysis | Transcripts formatted for copy-paste into Claude or ChatGPT |

---

## Current file structure (extension)

```
record-extension/
├── manifest.json
├── background.js                  # Service worker — recording + transcription pipeline
├── CLAUDE.md                      # This file
├── content-scripts/
│   ├── common.js
│   ├── meet.js
│   ├── zoom.js
│   └── teams.js
├── popup/
│   ├── popup.html
│   ├── popup.css                  # Dark theme — reference for all extension UI
│   └── popup.js
├── recorder/
│   ├── offscreen.html             # DO NOT MODIFY
│   └── recorder.js                # DO NOT MODIFY
├── storage/
│   └── storage-manager.js         # IndexedDB — local temp storage before upload
├── transcription/
│   └── assemblyai-client.js       # AssemblyAI functions
├── utils/
│   ├── platform-detector.js
│   └── helpers.js
└── icons/
```

---

## What has been built so far

### Recording pipeline (COMPLETE)
- Offscreen document + MediaRecorder
- tabCapture primary, desktopCapture fallback
- Service worker state management via chrome.storage.session
- IndexedDB local storage
- Popup UI with start/stop and timer
- Platform detection: Google Meet, Zoom, Teams

### Transcription pipeline (COMPLETE)
- assemblyai-client.js with uploadAudio, submitTranscriptionJob, fetchTranscriptResult, parseUtterances
- background.js extended with triggerTranscription, polling via chrome.alarms
- Segments saved to IndexedDB with status tracking

---

## Data formats

### Recording object in IndexedDB (local, pre-upload)
```js
{
  id: "generated-id",
  blob: Blob,
  date: Date,
  duration: Number,        // milliseconds
  label: String,           // e.g. "Interview — Sarah Johnson"
  meetingTitle: String,    // auto-captured from DOM
  status: "recording" | "processing" | "transcribed" | "uploaded",
  transcriptId: String,    // AssemblyAI job ID
  segments: Array,         // transcript segments
  uploadedBy: String       // Cognito username of the employee who recorded
}
```

### Transcript segment format
```js
{
  speaker: "Speaker_A",
  text: "Tell me about your experience.",
  start: 1200,            // milliseconds
  end: 3400,
  confidence: 0.94
}
```

### AI-ready transcript format (for dashboard export)
```
INTERVIEW TRANSCRIPT
Candidate: [label or name]
Date: [date]
Duration: [duration]
Recorded by: [employee name]

[00:00] Interviewer: Tell me about your background...
[00:45] Candidate: I have been working in sales for 5 years...

---
```
Speaker A maps to "Interviewer" by default, Speaker B to "Candidate". User can correct in dashboard.

---

## Authentication (AWS Cognito)

- Single Cognito User Pool for the company
- Same credentials for Chrome extension and web dashboard
- Extension stores Cognito JWT in chrome.storage.local after login
- Token used to sign S3 uploads
- Token refreshes using Cognito refresh token flow
- Employees added to User Pool by admin — no self-signup

---

## S3 structure

```
s3://[bucket-name]/
├── recordings/
│   └── [userId]/
│       └── [recordingId].webm
└── transcripts/
    └── [recordingId].json
```

Each upload tagged with Cognito userId so dashboard shows who uploaded it.

---

## What needs to be built (in order)

### Prompt A — Login UI in Extension
- Add a login screen to the popup using AWS Cognito
- Email + password input fields
- On success store JWT in chrome.storage.local
- Show logged-in employee name in popup header
- Logout button
- All recording controls hidden until logged in
- Do not modify recorder.js or offscreen.html

### Prompt B — Auto-upload to S3 after transcription
- After transcript status reaches "transcribed", auto-upload to S3
- Upload audio blob to recordings/[userId]/[recordingId].webm
- Upload transcript JSON to transcripts/[recordingId].json
- Tag upload with userId, date, label, duration
- Update IndexedDB status to "uploaded"
- Show upload progress in popup
- AWS region, bucket name, Cognito pool ID stored in chrome.storage.local

### Prompt C — Web Dashboard (separate site)
- Standalone website — plain HTML/CSS/JS, no framework
- Login page using same Cognito credentials
- After login, fetch all recordings from S3 for the company bucket
- List view: candidate label, date, duration, recorded by, status
- Click recording to open transcript view
- Transcript in AI-ready format with speaker labels
- "Copy for AI Analysis" button copies formatted transcript to clipboard
- Clean professional design for hiring managers

### Prompt D — Speaker Labeling in Dashboard
- In transcript view, rename Speaker_A / Speaker_B to real roles
- Default: Speaker_A = Interviewer, Speaker_B = Candidate
- Saving corrections updates transcript JSON in S3
- Corrected names used in AI-ready export

### Prompt E — Export and AI Formatting
- Export transcript as PDF from dashboard
- PDF header: company logo placeholder, candidate name, date, recorded by
- Body: formatted transcript with speaker names and timestamps
- "Copy for AI" exports plain text optimized for Claude or ChatGPT
- Prepend a ready-made analysis prompt:
  "Please analyze this interview transcript and provide:
   1) Overall candidate score out of 10
   2) Key strengths observed
   3) Areas of concern
   4) Hiring recommendation"

---

## Manifest permissions needed
Already have: tabCapture, desktopCapture, storage, alarms, offscreen, notifications, activeTab
Already have host permission: https://api.assemblyai.com/*
Still needed: https://cognito-idp.*.amazonaws.com/* and https://s3.amazonaws.com/*
