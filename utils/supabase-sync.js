/**
 * utils/supabase-sync.js
 * Pushes a finished recording (audio blob + transcript) to Supabase.
 * Pure functions — no chrome.* calls, no DOM. All credentials are passed in.
 *
 * Expected Supabase schema
 * ─────────────────────────
 * Storage bucket : "recordings"   (public read)
 * Table          : "transcripts"
 *   id           uuid  primary key default gen_random_uuid()
 *   recording_id text
 *   title        text
 *   platform     text
 *   start_time   timestamptz
 *   duration     int8          -- milliseconds
 *   segments     jsonb
 *   speaker_names jsonb
 *   audio_url    text
 *   created_at   timestamptz  default now()
 */

const STORAGE_BUCKET = 'recordings';
const TRANSCRIPT_TABLE = 'transcripts';

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Upload a Blob to the Supabase "recordings" storage bucket.
 * Uses upsert so re-syncing the same recording overwrites the old file.
 *
 * @param {Blob}   blob
 * @param {string} path  Filename inside the bucket, e.g. "rec_123.webm"
 * @param {{ supabaseUrl: string, supabaseAnonKey: string }} config
 * @returns {Promise<string>} Public URL of the uploaded file.
 */
export async function uploadAudioBlob(blob, path, { supabaseUrl, supabaseAnonKey }) {
  const endpoint = `${supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseAnonKey}`,
      'Content-Type': blob.type || 'audio/webm',
      'x-upsert': 'true',
    },
    body: blob,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Audio upload failed (${res.status}): ${detail}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

// ─── Database ─────────────────────────────────────────────────────────────────

/**
 * Insert a row into the "transcripts" table.
 * Supabase returns the inserted row including its generated uuid.
 *
 * @param {object} row
 * @param {{ supabaseUrl: string, supabaseAnonKey: string }} config
 * @returns {Promise<object>} The inserted row.
 */
export async function insertTranscriptRow(row, { supabaseUrl, supabaseAnonKey }) {
  const endpoint = `${supabaseUrl}/rest/v1/${TRANSCRIPT_TABLE}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseAnonKey}`,
      apikey: supabaseAnonKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Transcript insert failed (${res.status}): ${detail}`);
  }

  const [inserted] = await res.json();
  if (!inserted) throw new Error('Supabase returned an empty response after insert');
  return inserted;
}

/**
 * Fetch a single transcript row from the "transcripts" table by its uuid.
 *
 * @param {string} tid  The Supabase row id.
 * @param {{ supabaseUrl: string, supabaseAnonKey: string }} config
 * @returns {Promise<object>} The transcript row.
 */
export async function fetchTranscriptRow(tid, { supabaseUrl, supabaseAnonKey }) {
  const endpoint = `${supabaseUrl}/rest/v1/${TRANSCRIPT_TABLE}?id=eq.${encodeURIComponent(tid)}&select=*`;
  const res = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${supabaseAnonKey}`,
      apikey: supabaseAnonKey,
    },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Transcript fetch failed (${res.status}): ${detail}`);
  }

  const rows = await res.json();
  if (!rows.length) throw new Error('Transcript not found');
  return rows[0];
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Upload the audio blob and insert the transcript row in one call.
 * Returns the share URL pointing to the extension's share page.
 *
 * Note: the Blob must be present on the recording object.
 * Call this from an extension page context (popup) so chrome.runtime.getURL works.
 *
 * @param {object} recording  Full recording object from IndexedDB (must include .blob).
 * @param {{ supabaseUrl: string, supabaseAnonKey: string }} config
 * @returns {Promise<{ shareUrl: string, audioUrl: string, supabaseId: string }>}
 */
export async function syncRecording(recording, config) {
  const ext = recording.mimeType?.includes('webm') ? 'webm' : 'mp4';
  const audioPath = `${recording.id}.${ext}`;

  // 1. Upload audio blob to Supabase Storage.
  const audioUrl = await uploadAudioBlob(recording.blob, audioPath, config);

  // 2. Insert transcript row (upsert not needed — each sync is a new share).
  const row = await insertTranscriptRow(
    {
      recording_id:  recording.id,
      title:         recording.title ?? '',
      platform:      recording.platform ?? '',
      start_time:    new Date(recording.startTime).toISOString(),
      duration:      recording.duration ?? 0,
      segments:      recording.segments ?? [],
      speaker_names: recording.speakerNames ?? {},
      audio_url:     audioUrl,
    },
    config
  );

  const shareUrl = `${chrome.runtime.getURL('share/index.html')}?tid=${row.id}`;
  return { shareUrl, audioUrl, supabaseId: row.id };
}
