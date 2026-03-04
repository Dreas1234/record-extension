# MeetRecord — Claude Code Project Context

## What this product is

A two-part system for a company to record interviews, store them, and analyze candidates using AI.

**Part 1 — Chrome Extension**
Employees install it, go through a one-time setup wizard, log in with company credentials, record interviews, and it auto-uploads when done. Minimal UI.

**Part 2 — Web Dashboard (separate website)**
The whole team logs into a website to see all recordings and transcripts, who uploaded them, and formatted output ready to drop into an AI for candidate scoring and pattern analysis.

**Same Keycloak login works for both.** A lightweight backend API handles auth token exchange, pre-signed S3 URLs, and data retrieval — neither the extension nor the dashboard talk to S3 or Keycloak directly.

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

## 🔵 The Blue Dot Pattern — CRITICAL ARCHITECTURE RULE

> This extension follows the same tabCapture architecture used by professional recording extensions like Loom, Read AI, and Screencastify. Every developer and every Claude Code prompt must follow this pattern. Deviating from it causes the `Permission dismissed` / `[object DOMException]` error.

### The Rule: tabCapture lives in background.js ONLY

In Manifest V3, `chrome.tabCapture` **cannot be called from the offscreen document**. It must be called from the **background service worker**. The offscreen document receives only a `streamId` and uses `getUserMedia`.

### Correct flow (always):

```
popup.js (user clicks record)
  → chrome.runtime.sendMessage({ action: "startRecording", tabId })
    → background.js receives message
      → chrome.tabCapture.getMediaStreamId({ targetTabId, consumerTabId })
        → sends streamId to offscreen doc via chrome.runtime.sendMessage
          → recorder.js uses navigator.mediaDevices.getUserMedia({
              audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
            })
```

### NEVER do this (broken pattern):

```
// ❌ WRONG — called from offscreen doc or after async gap
chrome.tabCapture.capture(...)        // blocked in MV3 offscreen
chrome.tabCapture.getMediaStreamId() // blocked in offscreen
```

### background.js implementation (reference):

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startRecording') {
    chrome.tabCapture.getMediaStreamId(
      { targetTabId: message.tabId, consumerTabId: message.tabId },
      (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          console.error('[BG] tabCapture failed:', chrome.runtime.lastError?.message);
          sendResponse({ error: chrome.runtime.lastError?.message });
          return;
        }
        chrome.runtime.sendMessage({
          action: 'startRecordingOffscreen',
          streamId,
          recordingId: message.recordingId
        });
        sendResponse({ success: true });
      }
    );
    return true;
  }
});
```

---

## Tech stack

| Concern | Solution |
|---|---|
| Recording | Chrome tabCapture + MediaRecorder (Blue Dot pattern — see above) |
| Mic input | `navigator.mediaDevices.getUserMedia` for selected mic, mixed with tab audio |
| Transcription + diarization | AssemblyAI (speaker_labels: true) |
| File storage | AWS S3 — accessed only via backend pre-signed URLs |
| Authentication | Keycloak — credentials exchanged via backend `/auth/token`, never called directly |
| Backend API | Lightweight server (Node/Express or Lambda) — handles auth, pre-signed URLs, data retrieval |
| Database | Transcript metadata stored as JSON in S3, indexed by recordingId |
| Web dashboard | Standalone HTML/CSS/JS site — no framework |
| AI analysis | Transcripts formatted for copy-paste into Claude or ChatGPT |

---

## Architecture overview

```
Chrome Extension                   Backend API                     External Services
─────────────────                  ───────────                     ─────────────────
onboarding.js / popup.js
  → POST /auth/token         →     validates with Keycloak    →    Keycloak
  ← { token, displayName }

  → POST /upload-url         →     generates pre-signed URLs   →   AWS S3
  ← { uploadUrl, transcriptUploadUrl }
  → PUT directly to S3 URLs  →                                →    AWS S3 (pre-signed)

Web Dashboard
─────────────────
app.js
  → POST /auth/token         →     same as above
  → GET  /recordings/list    →     lists + fetches from S3     →   AWS S3
  → GET  /recordings/:id     →     fetches transcript JSON     →   AWS S3
  → PUT  /recordings/:id     →     saves updated JSON          →   AWS S3
```

Neither the extension nor the dashboard call Keycloak or S3 directly.

---

## Backend API contract

> The backend is a separate project. These are the endpoints the extension and dashboard depend on.

### POST /auth/token
```
Request:  { username, password }
Response: { token, expiresAt, userId, displayName }
```

### POST /upload-url
Requires `Authorization: Bearer [token]`
```
Request:  { recordingId, contentType: "audio/webm" }
Response: { uploadUrl, transcriptUploadUrl }
```
Pre-signed URLs must be valid for at least 15 minutes. Backend tags S3 objects with userId.

### GET /recordings/list
Requires `Authorization: Bearer [token]`
```
Response: [{ recordingId, label, date, duration, uploadedBy, status }, ...]
```

### GET /recordings/:recordingId
Requires `Authorization: Bearer [token]`
```
Response: { recordingId, label, date, duration, uploadedBy, speakerMap, segments }
```

### PUT /recordings/:recordingId
Requires `Authorization: Bearer [token]`
```
Request:  { speakerMap, label? }
Response: { success: true }
```

---

## Current file structure (extension)

```
record-extension/
├── manifest.json
├── background.js                  # Service worker — recording + transcription + upload
├── CLAUDE.md                      # This file
├── content-scripts/
│   ├── common.js
│   ├── meet.js
│   ├── zoom.js
│   └── teams.js
├── onboarding/
│   ├── onboarding.html            # Setup wizard — opens on first install
│   └── onboarding.js
├── popup/
│   ├── popup.html
│   ├── popup.css                  # Dark theme — reference for all extension UI
│   └── popup.js
├── recorder/
│   ├── offscreen.html             # DO NOT MODIFY
│   └── recorder.js                # DO NOT MODIFY (exception: mic mixing — Prompt C only)
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

## What has been built and verified working

### Recording pipeline ✅
- Offscreen document + MediaRecorder using Blue Dot pattern
- tabCapture via `getMediaStreamId` in background.js (NOT in offscreen)
- Stream passed to offscreen doc as `streamId`, used via `getUserMedia`
- Service worker state management via `chrome.storage.session`
- IndexedDB local storage via `storage-manager.js`
- Popup UI with start/stop and timer
- Platform detection: Google Meet, Zoom, Teams

### Transcription pipeline ✅
- `assemblyai-client.js` with `uploadAudio`, `submitTranscriptionJob`, `fetchTranscriptResult`, `parseUtterances`
- `background.js` extended with `triggerTranscription`, polling via `chrome.alarms`
- Segments saved to IndexedDB with status tracking

### Known issues / still to fix
- Transcripts may come back empty if test recordings are under ~20 seconds
- Dashboard not yet reading from backend API (still reading IndexedDB locally)
- "Unknown Platform" showing in some cases — platform-detector.js needs tuning
- Delete currently removes from IndexedDB only, not from S3 via backend

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
  meetingTitle: String,
  status: "recording" | "processing" | "transcribed" | "uploaded" | "upload_failed",
  transcriptId: String,    // AssemblyAI job ID
  segments: Array,
  uploadedBy: String       // userId from Keycloak token
}
```

### Transcript segment format
```js
{ speaker: "Speaker_A", text: "Tell me about your experience.", start: 1200, end: 3400, confidence: 0.94 }
```

### Transcript JSON saved to S3
```json
{
  "recordingId": "abc-123",
  "label": "Interview — Sarah Johnson",
  "date": "2025-03-01T14:30:00Z",
  "duration": 3480000,
  "uploadedBy": "jane.smith",
  "speakerMap": { "Speaker_A": "Interviewer", "Speaker_B": "Candidate" },
  "segments": [...]
}
```

---

## What needs to be built — with full Claude Code prompts

---

### Prompt A — Onboarding Wizard (first install)

**Goal:** On first install, open a setup wizard tab that walks through mic permission, config, and Keycloak login before the user can record anything.

```
Read manifest.json, background.js, popup/popup.html, popup/popup.js carefully before writing any code.

Create an onboarding wizard that opens automatically when the extension is first installed (not on every browser restart).

FILES TO CREATE:
- onboarding/onboarding.html
- onboarding/onboarding.js

TRIGGER IN background.js — add:
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
    }
  });

WIZARD STEPS (one step visible at a time, Next/Back navigation, progress bar at top):

Step 1 — Welcome
  - Brief explanation of what MeetRecord does
  - MeetRecord logo placeholder (grey box, 180x48px)
  - "Get Started" button to proceed

Step 2 — Microphone Permission
  - Explain why mic access is needed for recording interviews
  - "Grant Microphone Access" button that calls:
      navigator.mediaDevices.getUserMedia({ audio: true })
  - On grant: green checkmark, unlock Next button
  - On denial: red warning + instructions to enable in Chrome settings (chrome://settings/content/microphone)
  - Cannot proceed until permission is granted

Step 3 — Configuration
  - Text input: Backend API URL (e.g. https://api.yourcompany.com)
  - Text input: AssemblyAI API Key
  - Helper text: "Your IT admin should have provided these values"
  - Validate Backend API URL is a valid URL before allowing Next
  - On Next: save { apiBaseUrl, assemblyAiKey } to chrome.storage.local

Step 4 — Login
  - Email + password inputs
  - "Sign In" button that POSTs to [apiBaseUrl]/auth/token with { username, password }
  - On success: store { token, expiresAt, userId, displayName } in chrome.storage.local, show "Welcome, [displayName]!"
  - On failure: show error, allow retry
  - Cannot proceed until login succeeds

Step 5 — Done
  - "You're all set, [displayName]!" heading
  - Checklist: Microphone ✓  |  Config saved ✓  |  Logged in ✓
  - "Start Recording" button that closes this tab
  - Reminder: "Click the MeetRecord icon in your Chrome toolbar to begin"

STYLE:
  - Light background (white/off-white), clean professional look — different from popup dark theme
  - Max width 560px, centered on page, generous padding
  - Progress indicator at top: "Step 2 of 5" or dot indicators
  - system-ui font, 16px base

Do NOT modify recorder.js or offscreen.html.
Do NOT break any existing recording or transcription functionality.
```

---

### Prompt B — Login UI in Popup + Keycloak Auth

**Goal:** Show a Keycloak login screen (via backend) in the popup if not authenticated. Hide all recording controls until logged in.

```
Read popup/popup.html, popup/popup.css, popup/popup.js, background.js, manifest.json carefully before writing any code.

Add Keycloak authentication to the Chrome extension popup (via the backend API — no direct Keycloak calls).

Requirements:

1. In popup.js on load:
   - Read { token, expiresAt, displayName, apiBaseUrl } from chrome.storage.local
   - If token exists and expiresAt is in the future: show recording view
   - If no valid token but apiBaseUrl is missing: show "Setup required" message with link to onboarding
   - Otherwise: show login view

2. LOGIN VIEW (add to popup.html, hidden by default):
   - Email + password inputs
   - "Sign In" button
   - Error message area
   - Style must exactly match existing dark theme from popup.css

3. On "Sign In" click:
   - POST to [apiBaseUrl]/auth/token with { username, password }
   - On success: store { token, expiresAt, userId, displayName } in chrome.storage.local
   - Show displayName in popup header
   - Transition to recording view
   - On failure: show "Invalid email or password"

4. "Log out" button in recording view header:
   - Clears token, expiresAt, userId, displayName from chrome.storage.local
   - Returns to login view
   - Does NOT stop any active recording

5. Do NOT modify recorder.js or offscreen.html.
6. Do NOT break any existing recording functionality.
```

---

### Prompt C — Microphone Selection + Silence Warning

**Goal:** Add a mic selector dropdown to the popup. Mix mic audio into the recording. Warn if selected mic is silent during recording.

```
Read popup/popup.html, popup/popup.css, popup/popup.js, background.js, recorder/recorder.js carefully before writing any code.

Add microphone selection and silence detection to the extension.

PART 1 — MIC SELECTOR DROPDOWN (popup):

1. In popup.html, inside the recording view (visible when logged in), add:
   - A <select> dropdown labeled "Microphone" styled to match popup.css dark theme
   - A small refresh icon/button to re-enumerate devices

2. In popup.js:
   - After auth check, call navigator.mediaDevices.enumerateDevices()
   - Filter audioinput devices, populate dropdown
   - If device.label is blank (labels only appear post-permission-grant), show "Microphone 1", "Microphone 2" etc.
   - Save selected deviceId to chrome.storage.local as selectedMicDeviceId on change
   - Restore previously selected deviceId on load if still available

3. When sending startRecording message to background.js, include: { ..., selectedMicDeviceId }

PART 2 — MIX MIC AUDIO (recorder.js — this is the ONLY prompt permitted to modify recorder.js):

4. In background.js: pass selectedMicDeviceId through to the offscreen message:
   { action: 'startRecordingOffscreen', streamId, recordingId, selectedMicDeviceId }

5. In recorder.js, after getting the tab stream via getUserMedia with chromeMediaSourceId:
   - Also call getUserMedia({ audio: { deviceId: { exact: selectedMicDeviceId } } })
   - Use AudioContext to merge both streams:
       const ctx = new AudioContext();
       const dest = ctx.createMediaStreamDestination();
       ctx.createMediaStreamSource(tabStream).connect(dest);
       ctx.createMediaStreamSource(micStream).connect(dest);
   - Feed dest.stream into MediaRecorder
   - If mic getUserMedia fails: log warning, continue with tab audio only — do NOT block recording

PART 3 — SILENCE DETECTION WARNING:

6. In recorder.js, attach an AnalyserNode to the mic source:
       const analyser = ctx.createAnalyser();
       analyser.fftSize = 256;
       micSource.connect(analyser);
   - Every 5 seconds, sample analyser with getByteFrequencyData
   - If average < 5 (out of 255) for 15 consecutive seconds:
       chrome.runtime.sendMessage({ action: 'micSilenceWarning' })
   - If audio recovers (average >= 5): send { action: 'micSilenceCleared' }

7. In popup.js:
   - On micSilenceWarning: show warning bar below the timer (amber/red):
       "⚠ No audio detected from your microphone. Is the right input selected?"
     + small "Dismiss" button
   - On micSilenceCleared or Dismiss: hide the warning bar
   - Do NOT stop recording — warn only

8. Do NOT break the Blue Dot tabCapture pattern — streamId still comes from background.js.
9. Do NOT modify offscreen.html.
```

---

### Prompt D — Auto-upload to S3 via Backend Pre-signed URLs

**Goal:** After transcription, upload audio and transcript JSON to S3 using pre-signed URLs from the backend. No direct S3 calls.

```
Read background.js, storage/storage-manager.js, transcription/assemblyai-client.js, manifest.json carefully before writing any code.

After a recording reaches "transcribed" status, automatically upload to S3 via backend-issued pre-signed URLs.

Requirements:

1. After triggerTranscription completes and saves segments to IndexedDB, call: uploadToS3(recordingId)

2. uploadToS3:
   a. Load recording from IndexedDB (blob + metadata + segments)
   b. Read { token, userId, apiBaseUrl } from chrome.storage.local
   c. POST to [apiBaseUrl]/upload-url with { recordingId, contentType: "audio/webm" }
      Authorization: Bearer [token]
      → receives: { uploadUrl, transcriptUploadUrl }

   d. PUT blob to uploadUrl:
        fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'audio/webm' } })

   e. Build transcript JSON:
        { recordingId, label, date, duration, uploadedBy: userId,
          speakerMap: { "Speaker_A": "Interviewer", "Speaker_B": "Candidate" },
          segments }

   f. PUT JSON to transcriptUploadUrl:
        fetch(transcriptUploadUrl, { method: 'PUT', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } })

   g. Both succeed: update IndexedDB status to "uploaded"
   h. Any failure: update status to "upload_failed", log error, no automatic retry

3. Send { action: 'uploadProgress', recordingId, status } via chrome.runtime.sendMessage at each stage

4. In popup.js, listen for uploadProgress and display status below the recording entry:
   "Uploading..." | "Uploaded ✓" | "Upload failed — check connection"

5. Do NOT modify recorder.js or offscreen.html.
6. Do NOT break existing recording or transcription flow.
```

---

### Prompt E — Web Dashboard

**Goal:** Standalone HTML/CSS/JS website. Login → list recordings → view transcript → copy for AI.

```
Create a standalone web dashboard folder: dashboard/
Files: dashboard/index.html, dashboard/app.js, dashboard/styles.css
No framework — vanilla HTML, CSS, JavaScript only.

CONFIG at top of app.js:
  const CONFIG = { apiBaseUrl: 'https://api.yourcompany.com' };

1. LOGIN PAGE (default view):
   - Clean professional design — white background
   - Email + password, "Sign In" button
   - POST to [CONFIG.apiBaseUrl]/auth/token
   - Store { token, expiresAt, userId, displayName } in sessionStorage
   - Show recordings list on success

2. RECORDINGS LIST VIEW:
   - GET [apiBaseUrl]/recordings/list with Authorization: Bearer [token]
   - Table columns: Candidate Name | Date | Duration | Recorded By | Status
   - Click row → transcript view
   - "Refresh" button, loading state

3. TRANSCRIPT VIEW:
   - GET [apiBaseUrl]/recordings/:recordingId
   - Render lines using speakerMap to replace Speaker_A etc:
       [00:00] Interviewer: ...
       [00:45] Candidate: ...
   - "Copy for AI Analysis" button (format below)
   - "Edit Speaker Names" section (see Prompt F)
   - "Export PDF" button (see Prompt G)
   - Back button

4. Handle 401/403 responses anywhere: clear sessionStorage, redirect to login

5. AI COPY FORMAT:
       INTERVIEW TRANSCRIPT
       Candidate: [label]
       Date: [date]
       Duration: [e.g. "42 minutes"]
       Recorded by: [uploadedBy]

       TRANSCRIPT:
       [00:00] Interviewer: ...

       ---
       ANALYSIS REQUEST:
       Please analyze this interview transcript and provide a structured evaluation:
       1. CANDIDATE SCORE: Rate out of 10 with brief justification.
       2. KEY STRENGTHS: 3–5 specific strengths demonstrated.
       3. AREAS OF CONCERN: Red flags, gaps, or weaknesses.
       4. CULTURE FIT: Communication style and cultural alignment.
       5. HIRING RECOMMENDATION: Hire / Consider / Pass — with one-paragraph rationale.

   Show "Copied! Paste into Claude or ChatGPT" for 3 seconds after clicking.

6. STYLE: system-ui font, white/light-grey backgrounds, dark text, responsive for laptop, no animations.
```

---

### Prompt F — Speaker Labeling in Dashboard

**Goal:** Rename Speaker_A / Speaker_B inline, persist to S3 via backend.

```
Read dashboard/index.html, dashboard/app.js, dashboard/styles.css carefully before making changes.

1. "Edit Speaker Names" button in transcript view.

2. Clicking shows inline form (not modal):
   - One text input per unique speaker, pre-filled from speakerMap
   - "Save Labels" and "Cancel" buttons

3. On Save:
   - PUT to [apiBaseUrl]/recordings/[recordingId] with { speakerMap }
     Authorization: Bearer [token]
   - On success: re-render transcript, update Copy output, show "Labels saved ✓" for 2 seconds

4. No page reload, no scroll position loss. Consistent style with rest of dashboard.
```

---

### Prompt G — PDF Export from Dashboard

**Goal:** Print-to-PDF transcript export using window.print() — no external libraries.

```
Read dashboard/index.html, dashboard/app.js, dashboard/styles.css carefully before making changes.

1. "Export PDF" button in transcript view only.

2. Uses window.print() with @media print CSS — no external library.

3. Print layout:
   - Header: "MeetRecord — Interview Transcript" left | grey placeholder box (120×40px) right
   - Metadata: Candidate | Date | Duration | Recorded by
   - Horizontal rule
   - Full transcript: [timestamp] Speaker: text
   - 11pt+ font, black on white, good line-height

4. @media print:
   - Hide all nav, buttons, sidebars, copy bar
   - Show only header and transcript body
   - Avoid page breaks inside a single transcript line

5. Do not break any other dashboard functionality.
```

---

## Debugging reference

| Error | Cause | Fix |
|---|---|---|
| `Permission dismissed` | tabCapture called from offscreen or after async gap | Move `getMediaStreamId` to background.js only — Blue Dot pattern |
| `[object DOMException]` on startRecording | Same root cause | Same fix |
| Empty transcript from AssemblyAI | Recording < 20 seconds | Test with real interview-length recordings |
| `Unknown Platform` in popup | platform-detector.js DOM selectors stale | Update selectors for current Meet/Zoom/Teams DOM |
| Backend returns 401 | Token expired or not sent | Re-auth; check expiresAt logic; check Authorization header |
| Pre-signed URL upload 403 | URL expired before upload attempt | Begin upload immediately after receiving URL; backend must set 15min+ expiry |
| Mic dropdown shows no labels | Mic permission not yet granted | Onboarding step 2 grants permission; labels appear only after getUserMedia succeeds |
| No mic audio in recording | Wrong deviceId or AudioContext not merging | Check selectedMicDeviceId stored; verify AudioContext merge in recorder.js |
| Silence warning not appearing | Threshold too strict or silence window too short | Lower threshold (try 8) or extend window to 20s |
| Dashboard blank after login | Backend /recordings/list error | Check Authorization header; check backend CORS config allows dashboard origin |
