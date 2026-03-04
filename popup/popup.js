/**
 * popup/popup.js
 * Recording controls — start/stop, mic toggle, recordings list.
 */

import { formatDuration, formatTimestamp } from '../utils/helpers.js';
import { getAllRecordings, getRecording, deleteRecording, exportRecordingBlob } from '../storage/storage-manager.js';
import { signIn, signOut, getSession, getAuthConfig } from '../auth/backend-auth.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const statusDot      = document.getElementById('status-dot');
const statusText     = document.getElementById('status-text');
const timerEl        = document.getElementById('timer');
const btnRecord      = document.getElementById('btn-record');
const btnLabel       = document.getElementById('btn-record-label');
const recordingsList = document.getElementById('recordings-list');

// ─── State ────────────────────────────────────────────────────────────────────

let timerInterval      = null;
let recordingStartTime = null;
let currentSession     = null;

// ─── Timer ────────────────────────────────────────────────────────────────────

function startTimer(startTime) {
  recordingStartTime = startTime;
  timerEl.removeAttribute('hidden');
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timerEl.textContent = formatDuration(Date.now() - recordingStartTime);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  recordingStartTime = null;
  timerEl.setAttribute('hidden', '');
  timerEl.textContent = '00:00:00';
}

// ─── UI state ─────────────────────────────────────────────────────────────────

function applyRecordingState({ recording, startTime }) {
  if (recording) {
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Recording';
    btnLabel.textContent = 'Stop Recording';
    btnRecord.classList.replace('btn-primary', 'btn-danger');
    document.querySelector('.btn-icon').textContent = '⏹';
    startTimer(startTime);
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Not Recording';
    btnLabel.textContent = 'Start Recording';
    btnRecord.classList.replace('btn-danger', 'btn-primary');
    document.querySelector('.btn-icon').textContent = '▶';
    stopTimer();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendBg(type, extra = {}) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ type, ...extra }, resolve)
  );
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ─── Recordings list ──────────────────────────────────────────────────────────

async function renderRecordings() {
  const recordings = await getAllRecordings();
  if (!recordings.length) {
    recordingsList.innerHTML = '<p class="empty-state">No recordings yet.</p>';
    return;
  }

  const shown = recordings.slice(0, 10);
  const moreCount = recordings.length - shown.length;

  recordingsList.innerHTML = shown.map((r) => {
    const label = r.label || r.title || 'Untitled';
    const date  = formatTimestamp(r.startTime);
    const dur   = formatDuration(r.duration ?? 0);
    const statusHtml = formatUploadStatus(r.status);
    return `
      <div class="recording-item">
        <div class="recording-item-top">
          <div class="recording-item-title" title="${label}">${label}</div>
        </div>
        <div class="recording-item-meta">${date} · ${dur}</div>
        <div class="recording-upload-status" data-status-id="${r.id}">${statusHtml}</div>
        <div class="recording-item-actions">
          <button class="icon-btn-sm" data-action="download" data-id="${r.id}" title="Download">&#8681;</button>
          <button class="icon-btn-sm danger" data-action="delete" data-id="${r.id}" title="Delete">&#10005;</button>
        </div>
      </div>
    `;
  }).join('');

  if (moreCount > 0) {
    recordingsList.innerHTML += `
      <div class="recording-item" style="justify-content:center;padding:8px;">
        <button class="btn-link" data-action="view-all">${moreCount} more — View all</button>
      </div>`;
  }
}

recordingsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'view-all') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    return;
  }

  if (action === 'delete') {
    if (!confirm('Delete this recording?')) return;
    await deleteRecording(id);
    renderRecordings();
    return;
  }

  if (action === 'download') {
    const rec = await getRecording(id);
    if (rec) exportRecordingBlob(rec);
  }
});

// ─── Upload status ────────────────────────────────────────────────────────────

function formatUploadStatus(status) {
  switch (status) {
    case 'uploading':    return '<span class="upload-status uploading">Uploading…</span>';
    case 'uploaded':     return '<span class="upload-status uploaded">Uploaded &#10003;</span>';
    case 'upload_failed': return '<span class="upload-status failed">Upload failed — check connection</span>';
    case 'transcribed':  return '<span class="upload-status uploading">Preparing upload…</span>';
    case 'processing':   return '<span class="upload-status uploading">Transcribing…</span>';
    default:             return '';
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'UPLOAD_PROGRESS') {
    const el = document.querySelector(`[data-status-id="${message.recordingId}"]`);
    if (el) el.innerHTML = formatUploadStatus(message.status);
  }
});

// ─── Microphone selector ──────────────────────────────────────────────────────

const micSelect    = document.getElementById('mic-select');
const btnRefreshMics = document.getElementById('btn-refresh-mics');

async function populateMicDropdown() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');

    const { selectedMicDeviceId } = await chrome.storage.local.get({ selectedMicDeviceId: '' });

    micSelect.innerHTML = '<option value="">Default</option>';
    mics.forEach((mic, i) => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `Microphone ${i + 1}`;
      if (mic.deviceId === selectedMicDeviceId) opt.selected = true;
      micSelect.appendChild(opt);
    });
  } catch {
    // Permission not yet granted — leave default only
  }
}

micSelect.addEventListener('change', () => {
  chrome.storage.local.set({ selectedMicDeviceId: micSelect.value });
});

btnRefreshMics.addEventListener('click', () => populateMicDropdown());

// ─── Silence warning ─────────────────────────────────────────────────────────

const silenceWarning = document.getElementById('silence-warning');

document.getElementById('btn-dismiss-silence').addEventListener('click', () => {
  silenceWarning.classList.add('hidden');
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'AUTH_REQUIRED') {
    showLogin();
    loginError.textContent = 'Session expired. Please sign in again.';
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'MIC_SILENCE_WARNING') {
    silenceWarning.classList.remove('hidden');
  }
  if (message.type === 'MIC_SILENCE_CLEARED') {
    silenceWarning.classList.add('hidden');
  }
});

// ─── Record button ────────────────────────────────────────────────────────────

btnRecord.addEventListener('click', async () => {
  btnRecord.disabled = true;
  const state = await sendBg('GET_STATE');

  if (state?.recording) {
    await sendBg('STOP_RECORDING');
    silenceWarning.classList.add('hidden');
    await renderRecordings();
  } else {
    const tab = await getActiveTab();

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      alert('Please navigate to your meeting page first (Google Meet, Zoom, etc.) then click Start.');
      btnRecord.disabled = false;
      return;
    }

    const { selectedMicDeviceId } = await chrome.storage.local.get({ selectedMicDeviceId: '' });

    const result = await sendBg('START_RECORDING', {
      tabId: tab.id,
      captureMic: true,
      selectedMicDeviceId,
    });

    if (!result?.success) {
      alert(`Failed to start: ${result?.error ?? 'Unknown error'}`);
    }
  }

  const newState = await sendBg('GET_STATE');
  applyRecordingState(newState ?? {});
  btnRecord.disabled = false;
});

// ─── Auth views ───────────────────────────────────────────────────────────────

const loginView     = document.getElementById('login-view');
const setupRequired = document.getElementById('setup-required');
const mainEl        = document.querySelector('main');
const userInfo      = document.getElementById('user-info');
const userNameEl    = document.getElementById('user-name');

function hideAllViews() {
  loginView.classList.add('hidden');
  setupRequired.classList.add('hidden');
  mainEl.classList.add('hidden');
  userInfo.classList.add('hidden');
}

function showApp(session) {
  currentSession = session;
  hideAllViews();
  mainEl.classList.remove('hidden');
  userNameEl.textContent = session.displayName;
  userInfo.classList.remove('hidden');
  populateMicDropdown();
}

function showLogin() {
  currentSession = null;
  hideAllViews();
  loginView.classList.remove('hidden');
  // Close settings if open
  settingsPanel.classList.remove('open');
  btnSettings.classList.remove('active');
}

function showSetupRequired() {
  currentSession = null;
  hideAllViews();
  setupRequired.classList.remove('hidden');
  settingsPanel.classList.remove('open');
  btnSettings.classList.remove('active');
}

// ─── Login form ───────────────────────────────────────────────────────────────

const inputEmail  = document.getElementById('input-email');
const inputPasswd = document.getElementById('input-password');
const btnSignIn   = document.getElementById('btn-sign-in');
const loginError  = document.getElementById('login-error');

async function handleSignIn() {
  const email    = inputEmail.value.trim();
  const password = inputPasswd.value;
  if (!email || !password) return;

  loginError.textContent  = '';
  btnSignIn.disabled      = true;
  btnSignIn.textContent   = 'Signing in…';

  try {
    const session = await signIn(email, password);
    showApp(session);
    const state = await sendBg('GET_STATE');
    applyRecordingState(state ?? {});
    renderRecordings();
  } catch (err) {
    const msg = err.message;
    if (msg === 'INVALID_CREDENTIALS') {
      loginError.textContent = 'Invalid email or password.';
    } else if (msg === 'NETWORK_ERROR') {
      loginError.textContent = 'Cannot reach the server.';
    } else if (msg === 'NOT_CONFIGURED') {
      loginError.textContent = 'Setup required — open wizard.';
    } else {
      loginError.textContent = msg;
    }
  } finally {
    btnSignIn.disabled    = false;
    btnSignIn.textContent = 'Sign in';
  }
}

btnSignIn.addEventListener('click', handleSignIn);
inputPasswd.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSignIn(); });

document.getElementById('btn-logout').addEventListener('click', async () => {
  await signOut();
  showLogin();
});

// ─── Settings panel ───────────────────────────────────────────────────────────

const btnSettings   = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const inputApiUrl   = document.getElementById('input-api-url');
const inputApiKey   = document.getElementById('input-api-key');
const btnSave       = document.getElementById('btn-save-settings');
const settingsHint  = document.getElementById('settings-hint');

btnSettings.addEventListener('click', async () => {
  const isOpen = settingsPanel.classList.toggle('open');
  btnSettings.classList.toggle('active', isOpen);
  if (isOpen) {
    mainEl.classList.add('hidden');
    loginView.classList.add('hidden');
    setupRequired.classList.add('hidden');
  } else if (currentSession) {
    mainEl.classList.remove('hidden');
  } else {
    const authConfig = await getAuthConfig();
    if (!authConfig) {
      setupRequired.classList.remove('hidden');
    } else {
      loginView.classList.remove('hidden');
    }
  }
});

btnSave.addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiBaseUrl:       inputApiUrl.value.trim(),
    assemblyAiApiKey: inputApiKey.value.trim(),
  });
  settingsHint.textContent = 'Saved.';
  settingsHint.className = 'settings-hint ok';
  setTimeout(() => { settingsHint.textContent = ''; settingsHint.className = 'settings-hint'; }, 2000);
});

async function loadSettings() {
  const vals = await chrome.storage.local.get({
    apiBaseUrl:       '',
    assemblyAiApiKey: '',
  });
  inputApiUrl.value = vals.apiBaseUrl;
  inputApiKey.value = vals.assemblyAiApiKey;
}

// ─── Dashboard link ───────────────────────────────────────────────────────────

document.getElementById('btn-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

// ─── Setup required — link to onboarding ─────────────────────────────────────

document.getElementById('btn-open-onboarding').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  loadSettings();

  const session = await getSession();

  if (session) {
    // Check near-expiry: if token expires within 5 minutes, treat as expired
    const FIVE_MIN = 5 * 60 * 1000;
    if (session.expiresAt < Date.now() + FIVE_MIN) {
      await signOut();
      showLogin();
      loginError.textContent = 'Your session has expired. Please sign in again.';
      return;
    }
    showApp(session);
    const state = await sendBg('GET_STATE');
    applyRecordingState(state ?? {});
    renderRecordings();
    return;
  }

  // getSession() returned null — token missing or already expired.
  // Check if a token existed (means it expired) vs. never logged in.
  const { token } = await chrome.storage.local.get({ token: null });
  if (token) {
    // Had a session that expired — clean up stale keys
    await signOut();
    showLogin();
    loginError.textContent = 'Your session has expired. Please sign in again.';
    return;
  }

  // Never logged in — check if backend API is configured
  const authConfig = await getAuthConfig();
  if (!authConfig) {
    showSetupRequired();
  } else {
    showLogin();
  }
}

init();
