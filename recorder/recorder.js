/**
 * recorder/recorder.js
 * Runs inside the offscreen document.
 * Handles MediaRecorder lifecycle and chunked blob assembly.
 */

let mediaRecorder = null;
let recordedChunks = [];
let activeStream = null;

// ─── Preferred MIME type ──────────────────────────────────────────────────────

function getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

// ─── Start recording ──────────────────────────────────────────────────────────

async function startRecording({ streamId, captureMode }) {
  if (mediaRecorder?.state === 'recording') {
    return { success: false, error: 'Already recording' };
  }

  try {
    // Obtain the MediaStream from the stream ID provided by the service worker
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: captureMode === 'desktop' ? 'desktop' : 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: captureMode === 'desktop' ? 'desktop' : 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    };

    activeStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Optionally mix in microphone audio
    const settings = await getSettings();
    if (settings.recordAudio && captureMode !== 'desktop') {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(activeStream).connect(dest);
        ctx.createMediaStreamSource(micStream).connect(dest);
        // Replace audio tracks with mixed track
        activeStream.getAudioTracks().forEach((t) => activeStream.removeTrack(t));
        activeStream.addTrack(dest.stream.getAudioTracks()[0]);
      } catch {
        // Microphone unavailable — record tab audio only
      }
    }

    const mimeType = getSupportedMimeType();
    recordedChunks = [];

    mediaRecorder = new MediaRecorder(activeStream, {
      mimeType,
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 128_000,
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onerror = (e) => {
      console.error('[Recorder] MediaRecorder error:', e.error);
      chrome.runtime.sendMessage({ type: 'RECORDER_ERROR', error: e.error?.message });
    };

    // Collect data every 5 seconds for resilience
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
      const mimeType = mediaRecorder.mimeType || 'video/webm';
      const blob = new Blob(recordedChunks, { type: mimeType });
      cleanup();

      // Transfer the blob back to the service worker via a message
      // (Blobs can't cross the offscreen boundary directly, so we use a URL or ArrayBuffer)
      blob.arrayBuffer().then((buffer) => {
        resolve({
          success: true,
          buffer,       // ArrayBuffer — serializable
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
  activeStream = null;
  mediaRecorder = null;
  recordedChunks = [];
}

// ─── Settings shim (offscreen has no direct storage access via import) ────────

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ recordAudio: true, recordVideo: true }, resolve);
  });
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
