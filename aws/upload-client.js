/**
 * aws/upload-client.js
 * Upload audio and transcript JSON to S3 via backend-issued pre-signed URLs.
 * No direct AWS or S3 calls — the backend handles URL generation.
 *
 * Backend contract:
 *   POST [apiBaseUrl]/upload-url
 *   Headers: Authorization: Bearer [token]
 *   Request:  { recordingId, contentType: "audio/webm" }
 *   Response: { uploadUrl, transcriptUploadUrl }
 */

import { getRecording, updateRecording } from '../storage/storage-manager.js';
import { getSession } from '../auth/backend-auth.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function broadcast(recordingId, status) {
  chrome.runtime.sendMessage({ type: 'UPLOAD_PROGRESS', recordingId, status }).catch(() => {});
}

// ─── Retry helper ────────────────────────────────────────────────────────────

/**
 * PUT with one retry on network error (TypeError from fetch).
 * Does NOT retry on 4xx — those are permanent failures.
 */
async function putWithRetry(url, body, headers) {
  try {
    const resp = await fetch(url, { method: 'PUT', body, headers });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('[upload-client] S3 PUT error:', resp.status, text);
      throw new Error(`Upload failed (${resp.status}): ${text}`);
    }
    return resp;
  } catch (err) {
    if (err instanceof TypeError) {
      // Network error — retry once after 10 seconds
      await new Promise((r) => setTimeout(r, 10_000));
      const resp = await fetch(url, { method: 'PUT', body, headers });
      if (!resp.ok) throw new Error(`Upload failed after retry (${resp.status})`);
      return resp;
    }
    throw err;
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Upload a recording's audio blob and transcript JSON to S3 using
 * backend-issued pre-signed URLs.
 *
 * @param {string} recordingId  IndexedDB record key.
 * @returns {Promise<void>}
 * @throws {Error} On any failure (after updating IndexedDB status to 'upload_failed').
 */
export async function uploadRecordingToS3(recordingId) {
  // a. Load recording from IndexedDB
  const recording = await getRecording(recordingId);
  if (!recording?.blob) {
    throw new Error(`No recording or blob found for ${recordingId}`);
  }

  // b. Get session
  const session = await getSession();
  if (!session) {
    throw new Error('NOT_AUTHENTICATED');
  }

  try {
    // c. Request pre-signed URLs from backend
    const resp = await fetch(`${session.apiBaseUrl}/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.token}`,
      },
      body: JSON.stringify({ recordingId, contentType: 'audio/webm' }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Backend /upload-url failed (${resp.status}): ${text}`);
    }

    const { uploadUrl, transcriptUploadUrl } = await resp.json();

    // d. Broadcast uploading
    await updateRecording(recordingId, { status: 'uploading' });
    broadcast(recordingId, 'uploading');

    // e. PUT audio blob (retries once on network error)
    await putWithRetry(uploadUrl, recording.blob, { 'Content-Type': 'audio/webm' });

    // f. Build transcript JSON
    const transcriptData = {
      recordingId,
      label:      recording.label || recording.title || '',
      date:       new Date(recording.startTime).toISOString(),
      duration:   recording.duration ?? 0,
      uploadedBy: session.userId,
      speakerMap: recording.speakerNames ?? {},
      segments:   recording.segments ?? [],
    };

    // g. PUT transcript JSON (retries once on network error)
    await putWithRetry(transcriptUploadUrl, JSON.stringify(transcriptData), { 'Content-Type': 'application/json' });

    // h. Both succeeded
    await updateRecording(recordingId, {
      status:     'uploaded',
      uploadedBy: session.userId,
      uploadedAt: Date.now(),
    });
    broadcast(recordingId, 'uploaded');

  } catch (err) {
    // i. Any failure
    console.error('[upload-client] Upload failed for', recordingId, err);
    await updateRecording(recordingId, {
      status:      'upload_failed',
      uploadError: err.message,
    }).catch(() => {});
    broadcast(recordingId, 'upload_failed');
    throw err;
  }
}
