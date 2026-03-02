/**
 * transcription/assemblyai-client.js
 * AssemblyAI REST client — upload, submit, poll, parse.
 * Designed to run inside the MV3 service worker (no DOM required).
 */

const BASE_URL = 'https://api.assemblyai.com';

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Upload raw audio bytes to AssemblyAI's temporary storage.
 * @param {ArrayBuffer} audioBuffer  Raw audio data from the recorder.
 * @param {string}      apiKey
 * @returns {Promise<string>}        Hosted upload URL to pass to submitTranscriptionJob.
 */
export async function uploadAudio(audioBuffer, apiKey) {
  const res = await fetch(`${BASE_URL}/v2/upload`, {
    method: 'POST',
    headers: {
      'authorization': apiKey,
      'content-type': 'application/octet-stream',
    },
    body: audioBuffer,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AssemblyAI upload failed (${res.status}): ${body}`);
  }

  const { upload_url } = await res.json();
  return upload_url;
}

// ─── Submit transcript job ────────────────────────────────────────────────────

/**
 * Submit a transcription job with speaker diarization.
 * @param {string} uploadUrl        URL returned by uploadAudio.
 * @param {string} apiKey
 * @param {object} opts
 * @param {number} opts.speakersExpected  How many distinct speakers to expect (default 2).
 * @returns {Promise<string>}            AssemblyAI transcript job ID.
 */
export async function submitTranscriptionJob(uploadUrl, apiKey, { speakersExpected = 2 } = {}) {
  const res = await fetch(`${BASE_URL}/v2/transcript`, {
    method: 'POST',
    headers: {
      'authorization': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speech_models: ['universal-2'],
      speaker_labels: true,
      speakers_expected: speakersExpected,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AssemblyAI submit failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.id;
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the current status of a transcript job.
 * Possible statuses: 'queued' | 'processing' | 'completed' | 'error'
 * @param {string} transcriptId
 * @param {string} apiKey
 * @returns {Promise<object>}  Full AssemblyAI transcript response object.
 */
export async function fetchTranscriptResult(transcriptId, apiKey) {
  const res = await fetch(`${BASE_URL}/v2/transcript/${transcriptId}`, {
    headers: { 'authorization': apiKey },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AssemblyAI poll failed (${res.status}): ${body}`);
  }

  return res.json();
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Convert AssemblyAI utterances into the app's segment schema.
 *
 * AssemblyAI utterance:
 *   { speaker: "A", text: "...", start: 1234, end: 5678, confidence: 0.97, words: [...] }
 *
 * Output segment:
 *   { speaker: "Speaker_A", text: "...", start: 1234, end: 5678, confidence: 0.97 }
 *
 * @param {Array} utterances  `result.utterances` from AssemblyAI.
 * @returns {Array<{ speaker: string, text: string, start: number, end: number, confidence: number }>}
 */
export function parseUtterances(utterances) {
  if (!Array.isArray(utterances)) return [];

  return utterances.map((u) => ({
    speaker: `Speaker_${u.speaker}`,   // "A" → "Speaker_A"
    text: u.text,
    start: u.start,                    // ms from start of audio
    end: u.end,
    confidence: parseFloat((u.confidence ?? 0).toFixed(2)),
  }));
}
