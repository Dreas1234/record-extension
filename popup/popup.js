/**
 * popup/popup.js
 * Recording controls — start/stop, mic toggle, recordings list.
 */

import { formatDuration, formatTimestamp } from '../utils/helpers.js';
import { getAllRecordings, getRecording, deleteRecording, exportRecordingBlob } from '../storage/storage-manager.js';
import { signIn, signOut, getSession } from '../auth/cognito-client.js';

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

  recordingsList.innerHTML = recordings.slice(0, 10).map((r) => {
    const label = r.label || r.title || 'Untitled';
    const date  = formatTimestamp(r.startTime);
    const dur   = formatDuration(r.duration ?? 0);
    return `
      <div class="recording-item">
        <div class="recording-item-top">
          <div class="recording-item-title" title="${label}">${label}</div>
        </div>
        <div class="recording-item-meta">${date} · ${dur}</div>
        <div class="recording-item-actions">
          <button class="icon-btn-sm" data-action="download" data-id="${r.id}" title="Download">&#8681;</button>
          <button class="icon-btn-sm danger" data-action="delete" data-id="${r.id}" title="Delete">&#10005;</button>
        </div>
      </div>
    `;
  }).join('');
}

recordingsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

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

// ─── Record button ────────────────────────────────────────────────────────────

btnRecord.addEventListener('click', async () => {
  btnRecord.disabled = true;
  const state = await sendBg('GET_STATE');

  if (state?.recording) {
    await sendBg('STOP_RECORDING');
    await renderRecordings();
  } else {
    const tab = await getActiveTab();

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      alert('Please navigate to your meeting page first (Google Meet, Zoom, etc.) then click Start.');
      btnRecord.disabled = false;
      return;
    }

    const result = await sendBg('START_RECORDING', {
      tabId: tab.id,
      captureMic: true,
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

const loginView  = document.getElementById('login-view');
const mainEl     = document.querySelector('main');
const userInfo   = document.getElementById('user-info');
const userNameEl = document.getElementById('user-name');

function showApp(session) {
  currentSession = session;
  loginView.classList.add('hidden');
  mainEl.classList.remove('hidden');
  userNameEl.textContent = session.displayName;
  userInfo.classList.remove('hidden');
}

function showLogin() {
  currentSession = null;
  mainEl.classList.add('hidden');
  loginView.classList.remove('hidden');
  userInfo.classList.add('hidden');
  // Close settings if open
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
    loginError.textContent = err.message;
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

const btnSettings       = document.getElementById('btn-settings');
const settingsPanel     = document.getElementById('settings-panel');
const inputApiKey       = document.getElementById('input-api-key');
const inputS3Bucket     = document.getElementById('input-s3-bucket');
const inputAwsRegion    = document.getElementById('input-aws-region');
const inputUserPoolId   = document.getElementById('input-user-pool-id');
const inputIdentityPool = document.getElementById('input-identity-pool-id');
const inputClientId     = document.getElementById('input-client-id');
const btnSave           = document.getElementById('btn-save-settings');
const settingsHint      = document.getElementById('settings-hint');

btnSettings.addEventListener('click', () => {
  const isOpen = settingsPanel.classList.toggle('open');
  btnSettings.classList.toggle('active', isOpen);
  if (isOpen) {
    mainEl.classList.add('hidden');
    loginView.classList.add('hidden');
  } else if (currentSession) {
    mainEl.classList.remove('hidden');
  } else {
    loginView.classList.remove('hidden');
  }
});

btnSave.addEventListener('click', async () => {
  await chrome.storage.local.set({
    assemblyAiApiKey:      inputApiKey.value.trim(),
    s3Bucket:              inputS3Bucket.value.trim(),
    cognitoRegion:         inputAwsRegion.value.trim(),
    cognitoUserPoolId:     inputUserPoolId.value.trim(),
    cognitoIdentityPoolId: inputIdentityPool.value.trim(),
    cognitoClientId:       inputClientId.value.trim(),
  });
  settingsHint.textContent = 'Saved.';
  settingsHint.className = 'settings-hint ok';
  setTimeout(() => { settingsHint.textContent = ''; settingsHint.className = 'settings-hint'; }, 2000);
});

async function loadSettings() {
  const vals = await chrome.storage.local.get({
    assemblyAiApiKey:      '',
    s3Bucket:              '',
    cognitoRegion:         '',
    cognitoUserPoolId:     '',
    cognitoIdentityPoolId: '',
    cognitoClientId:       '',
  });
  inputApiKey.value       = vals.assemblyAiApiKey;
  inputS3Bucket.value     = vals.s3Bucket;
  inputAwsRegion.value    = vals.cognitoRegion;
  inputUserPoolId.value   = vals.cognitoUserPoolId;
  inputIdentityPool.value = vals.cognitoIdentityPoolId;
  inputClientId.value     = vals.cognitoClientId;
}

// ─── Dashboard link ───────────────────────────────────────────────────────────

document.getElementById('btn-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  loadSettings();
  const session = await getSession();
  if (session) {
    showApp(session);
    const state = await sendBg('GET_STATE');
    applyRecordingState(state ?? {});
    renderRecordings();
  } else {
    showLogin();
  }
}

init();
