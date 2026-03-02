/**
 * recorder/recorder.js
 * Runs inside the offscreen document.
 * Handles MediaRecorder lifecycle and chunked blob assembly.
 * Supports tab-only audio or tab + microphone mixed recording.
 */

let mediaRecorder = null;
let recordedChunks = [];
let activeStream    = null;  // tab/desktop capture stream
let activeMicStream = null;  // microphone stream
let activeAudioCtx  = null;  // AudioContext used for mixing

// ─── Preferred MIME type ──────────────────────────────────────────────────────

function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'audio/webm';
}

// ─── Start recording ──────────────────────────────────────────────────────────

async function startRecording({ streamId, captureMode, captureMic = false }) {
  if (mediaRecorder?.state === 'recording') {
    return { success: false, error: 'Already recording' };
  }

  try {
    const source = captureMode === 'desktop' ? 'desktop' : 'tab';

    // Tab capture requires video to be requested even when only audio is wanted —
    // Chrome will not activate the tab's audio pipeline for audio-only constraints.
    activeStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: source,
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: source,
          chromeMediaSourceId: streamId,
        },
      },
    });

    const mimeType = getSupportedMimeType();
    recordedChunks = [];

    let recordStream;

    if (captureMic) {
      // ── Mixed recording: tab audio + microphone ──────────────────────────────
      activeMicStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression:  true,
          sampleRate:        48000,
        },
        video: false,
      });

      const audioCtx   = new AudioContext();
      activeAudioCtx   = audioCtx;
      const destination = audioCtx.createMediaStreamDestination();

      // Connect both sources into the single destination
      audioCtx.createMediaStreamSource(
        new MediaStream(activeStream.getAudioTracks())
      ).connect(destination);

      audioCtx.createMediaStreamSource(activeMicStream).connect(destination);

      recordStream = destination.stream;
    } else {
      // ── Tab audio only ───────────────────────────────────────────────────────
      recordStream = new MediaStream(activeStream.getAudioTracks());
    }

    mediaRecorder = new MediaRecorder(recordStream, {
      mimeType,
      audioBitsPerSecond: 128_000,
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onerror = (e) => {
      console.error('[Recorder] MediaRecorder error:', e.error);
    };

    mediaRecorder.start(5000);
    return { success: true, mimeType };
  } catch (err) {
    console.error('[Recorder] startRecording error:', err);
    cleanup();
    return { success: false, error: err.message };
  }
}

// ─── Stop recording ───────────────────────────────────────────────────────────

function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      cleanup();
      resolve({ success: true, blob: null });
      return;
    }

    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(recordedChunks, { type: mimeType });
      cleanup();

      blob.arrayBuffer().then((arrayBuffer) => {
        resolve({
          success: true,
          buffer: Array.from(new Uint8Array(arrayBuffer)),
          mimeType,
          size: blob.size,
        });
      });
    };

    mediaRecorder.stop();
  });
}

// ─── Pause / Resume ───────────────────────────────────────────────────────────

function pauseRecording() {
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.pause();
    return { success: true };
  }
  return { success: false, error: 'Not recording' };
}

function resumeRecording() {
  if (mediaRecorder?.state === 'paused') {
    mediaRecorder.resume();
    return { success: true };
  }
  return { success: false, error: 'Not paused' };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanup() {
  activeStream?.getTracks().forEach((t) => t.stop());
  activeMicStream?.getTracks().forEach((t) => t.stop());
  activeAudioCtx?.close();
  activeStream    = null;
  activeMicStream = null;
  activeAudioCtx  = null;
  mediaRecorder   = null;
  recordedChunks  = [];
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type } = message;

  if (type === 'OFFSCREEN_START_RECORDING') {
    startRecording(message).then(sendResponse);
    return true;
  }

  if (type === 'OFFSCREEN_STOP_RECORDING') {
    stopRecording().then(sendResponse);
    return true;
  }

  if (type === 'OFFSCREEN_PAUSE_RECORDING') {
    sendResponse(pauseRecording());
    return false;
  }

  if (type === 'OFFSCREEN_RESUME_RECORDING') {
    sendResponse(resumeRecording());
    return false;
  }
});
