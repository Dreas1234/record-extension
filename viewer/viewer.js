/**
 * viewer/viewer.js
 * Transcript viewer — loads a recording by ?id=, renders segments,
 * and supports inline speaker renaming.
 */

import { getRecording, updateRecording } from '../storage/storage-manager.js';
import { formatDuration, formatTimestamp } from '../utils/helpers.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const titleEl       = document.getElementById('recording-title');
const infoEl        = document.getElementById('recording-info');
const statusBadge   = document.getElementById('status-badge');
const loadingState  = document.getElementById('loading-state');
const errorState    = document.getElementById('error-state');
const errorText     = document.getElementById('error-text');
const noTranscript  = document.getElementById('no-transcript');
const transcriptBody = document.getElementById('transcript-body');

// ─── State ────────────────────────────────────────────────────────────────────

let recording = null;

// Ordered list of unique raw speaker labels (determines color assignment).
let speakerOrder = [];

// Speaker color palette (dark-theme friendly, 8 slots).
const SPEAKER_COLORS = [
  '#3b82f6', // blue
  '#a855f7', // purple
  '#22c55e', // green
  '#f97316', // orange
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
  '#ef4444', // red
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format ms as M:SS or H:MM:SS. */
function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Resolve a raw speaker label to a display name. */
function resolveSpeaker(raw) {
  return recording.speakerNames?.[raw] ?? raw;
}

/** Return a stable color for a raw speaker label. */
function speakerColor(raw) {
  const idx = speakerOrder.indexOf(raw);
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0];
}

/** Group consecutive same-speaker segments into turns. */
function groupIntoTurns(segments) {
  const turns = [];
  for (const seg of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.segments.push(seg);
    } else {
      turns.push({ speaker: seg.speaker, segments: [seg] });
    }
  }
  return turns;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderTurn(turn) {
  const displayName = resolveSpeaker(turn.speaker);
  const color = speakerColor(turn.speaker);

  const segsHtml = turn.segments.map((seg) => {
    const lowConf = typeof seg.confidence === 'number' && seg.confidence < 0.80;
    const confPct = typeof seg.confidence === 'number'
      ? Math.round(seg.confidence * 100)
      : null;
    const confBadge = lowConf
      ? `<span class="conf-warning" title="Low confidence: ${confPct}%">&#9888;</span>`
      : '';

    return `<div class="segment${lowConf ? ' low-confidence' : ''}">
        <span class="segment-time">${formatTime(seg.start)}</span>
        <span class="segment-text">${escapeHtml(seg.text)}${confBadge}</span>
      </div>`;
  }).join('\n');

  return `<div class="turn" data-speaker="${escapeHtml(turn.speaker)}">
      <div class="turn-header">
        <button class="speaker-label" data-raw="${escapeHtml(turn.speaker)}"
                style="color: ${color}">
          ${escapeHtml(displayName)}
        </button>
      </div>
      <div class="turn-segments">${segsHtml}</div>
    </div>`;
}

function renderTranscript() {
  // Collect unique speakers in order of first appearance.
  speakerOrder = [...new Set(recording.segments.map((s) => s.speaker))];

  const turns = groupIntoTurns(recording.segments);
  transcriptBody.innerHTML = turns.map(renderTurn).join('\n');
  transcriptBody.removeAttribute('hidden');
}

// ─── Speaker renaming ─────────────────────────────────────────────────────────

transcriptBody.addEventListener('click', (e) => {
  const btn = e.target.closest('.speaker-label');
  if (!btn) return;
  startRename(btn);
});

function startRename(btn) {
  const raw = btn.dataset.raw;
  const current = resolveSpeaker(raw);

  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'speaker-rename-input';
  input.setAttribute('aria-label', 'Rename speaker');

  btn.replaceWith(input);
  input.select();

  let committed = false;

  function commit() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    input.replaceWith(btn);
    if (newName && newName !== current) {
      applyRename(raw, newName, btn);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; input.replaceWith(btn); }
  });
  input.addEventListener('blur', commit);
}

async function applyRename(raw, newName, originBtn) {
  // Update in-memory state.
  if (!recording.speakerNames) recording.speakerNames = {};
  recording.speakerNames[raw] = newName;

  // Persist to IndexedDB.
  await updateRecording(recording.id, { speakerNames: recording.speakerNames });

  // Update every speaker-label button for this raw label (could span multiple turns).
  document.querySelectorAll(`.speaker-label[data-raw="${CSS.escape(raw)}"]`).forEach((btn) => {
    btn.textContent = newName;
  });
}

// ─── Loading / error states ───────────────────────────────────────────────────

function showError(msg) {
  loadingState.setAttribute('hidden', '');
  errorText.textContent = msg;
  errorState.removeAttribute('hidden');
}

function hideLoading() {
  loadingState.setAttribute('hidden', '');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  recording:   'Recording',
  processing:  'Transcribing…',
  transcribed: 'Transcribed',
  saved:       'Saved',
};

async function init() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');

  if (!id) {
    showError('No recording ID provided.');
    return;
  }

  recording = await getRecording(id);

  if (!recording) {
    showError('Recording not found.');
    return;
  }

  // Populate header.
  document.title = `${recording.title} — MeetRecord`;
  titleEl.textContent = recording.title;
  infoEl.textContent = [
    formatTimestamp(recording.startTime),
    formatDuration(recording.duration ?? 0),
  ].join(' · ');

  const statusLabel = STATUS_LABELS[recording.status] ?? recording.status;
  if (statusLabel) {
    statusBadge.textContent = statusLabel;
    statusBadge.className = `status-badge status-${recording.status}`;
    statusBadge.removeAttribute('hidden');
  }

  hideLoading();

  if (!recording.segments?.length) {
    noTranscript.removeAttribute('hidden');
    return;
  }

  renderTranscript();
}

init();
