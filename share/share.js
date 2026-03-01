/**
 * share/share.js
 * Loads a shared transcript from Supabase and renders it read-only.
 *
 * URL format: share/index.html?tid={supabase_row_id}
 *
 * The viewer fetches its credentials from chrome.storage.sync, so the recipient
 * must have the MeetRecord extension installed with Supabase settings configured.
 */

import { fetchTranscriptRow } from '../utils/supabase-sync.js';
import { formatDuration, formatTimestamp } from '../utils/helpers.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const titleEl        = document.getElementById('recording-title');
const infoEl         = document.getElementById('recording-info');
const platformBadge  = document.getElementById('platform-badge');
const loadingState   = document.getElementById('loading-state');
const errorState     = document.getElementById('error-state');
const errorText      = document.getElementById('error-text');
const errorHint      = document.getElementById('error-hint');
const transcriptBody = document.getElementById('transcript-body');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

const SPEAKER_COLORS = [
  '#3b82f6', '#a855f7', '#22c55e', '#f97316',
  '#ec4899', '#14b8a6', '#eab308', '#ef4444',
];

function speakerColor(raw, order) {
  const idx = order.indexOf(raw);
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0];
}

function resolveSpeaker(raw, speakerNames) {
  return speakerNames?.[raw] ?? raw;
}

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

function renderTranscript(row) {
  const segments     = row.segments ?? [];
  const speakerNames = row.speaker_names ?? {};

  if (!segments.length) {
    transcriptBody.innerHTML = '<p style="color:var(--c-muted);padding:24px 0">No transcript segments available.</p>';
    transcriptBody.removeAttribute('hidden');
    return;
  }

  const speakerOrder = [...new Set(segments.map((s) => s.speaker))];
  const turns = groupIntoTurns(segments);

  transcriptBody.innerHTML = turns.map((turn) => {
    const displayName = resolveSpeaker(turn.speaker, speakerNames);
    const color = speakerColor(turn.speaker, speakerOrder);

    const segsHtml = turn.segments.map((seg) => {
      const lowConf = typeof seg.confidence === 'number' && seg.confidence < 0.80;
      const confPct = typeof seg.confidence === 'number' ? Math.round(seg.confidence * 100) : null;
      const confBadge = lowConf
        ? `<span class="conf-warning" title="Low confidence: ${confPct}%">&#9888;</span>`
        : '';

      return `<div class="segment${lowConf ? ' low-confidence' : ''}">
          <span class="segment-time">${formatTime(seg.start)}</span>
          <span class="segment-text">${escapeHtml(seg.text)}${confBadge}</span>
        </div>`;
    }).join('\n');

    return `<div class="turn">
        <div class="turn-header">
          <span class="speaker-name" style="color:${color}">${escapeHtml(displayName)}</span>
        </div>
        <div class="turn-segments">${segsHtml}</div>
      </div>`;
  }).join('\n');

  transcriptBody.removeAttribute('hidden');
}

// ─── Error / loading ──────────────────────────────────────────────────────────

function showError(msg, showSettingsHint = false) {
  loadingState.setAttribute('hidden', '');
  errorText.textContent = msg;
  errorHint.toggleAttribute('hidden', !showSettingsHint);
  errorState.removeAttribute('hidden');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  const tid = params.get('tid');

  if (!tid) {
    showError('No transcript ID in URL.');
    return;
  }

  const { supabaseUrl = '', supabaseAnonKey = '' } = await chrome.storage.sync.get({
    supabaseUrl: '',
    supabaseAnonKey: '',
  });

  if (!supabaseUrl || !supabaseAnonKey) {
    showError('Supabase credentials are not configured.', true);
    return;
  }

  let row;
  try {
    row = await fetchTranscriptRow(tid, { supabaseUrl, supabaseAnonKey });
  } catch (err) {
    showError(err.message);
    return;
  }

  // Populate header.
  const title = row.title || 'Untitled Recording';
  document.title = `${title} — MeetRecord`;
  titleEl.textContent = title;
  infoEl.textContent = [
    row.start_time ? formatTimestamp(new Date(row.start_time).getTime()) : '',
    row.duration    ? formatDuration(row.duration) : '',
  ].filter(Boolean).join(' · ');

  if (row.platform) {
    platformBadge.textContent = row.platform;
    platformBadge.removeAttribute('hidden');
  }

  loadingState.setAttribute('hidden', '');
  renderTranscript(row);
}

init();
