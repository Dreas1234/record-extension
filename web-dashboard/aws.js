/**
 * web-dashboard/aws.js
 * Backend API calls for recordings and transcripts.
 * Replaces direct S3/Cognito access — all data flows through the backend.
 */

import { apiFetch } from './auth.js';

/**
 * GET /recordings/list
 * @returns {Promise<Array<{ recordingId, label, date, duration, uploadedBy, status }>>}
 */
export async function fetchRecordingsList() {
  const resp = await apiFetch('/recordings/list');
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Failed to load recordings (${resp.status})`);
  }
  return resp.json();
}

/**
 * GET /recordings/:id
 * @param {string} recordingId
 * @returns {Promise<{ recordingId, label, date, duration, uploadedBy, speakerMap, segments }>}
 */
export async function fetchTranscript(recordingId) {
  const resp = await apiFetch(`/recordings/${encodeURIComponent(recordingId)}`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Failed to load transcript (${resp.status})`);
  }
  return resp.json();
}

/**
 * PUT /recordings/:id
 * @param {string} recordingId
 * @param {{ speakerMap?: object, label?: string }} data
 * @returns {Promise<{ success: boolean }>}
 */
export async function updateTranscript(recordingId, data) {
  const resp = await apiFetch(`/recordings/${encodeURIComponent(recordingId)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Failed to save (${resp.status})`);
  }
  return resp.json();
}
