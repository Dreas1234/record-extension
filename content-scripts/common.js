/**
 * content-scripts/common.js
 * Shared overlay UI and messaging helpers injected alongside platform scripts.
 */

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__meetRecordInjected) return;
  window.__meetRecordInjected = true;

  // ─── Overlay Badge ────────────────────────────────────────────────────────

  let overlay = null;
  let timerInterval = null;
  let recordingStart = null;

  function createOverlay() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = '__meetrecord-overlay';
    overlay.innerHTML = `
      <span id="__mr-dot"></span>
      <span id="__mr-label">REC</span>
      <span id="__mr-timer">00:00:00</span>
      <button id="__mr-stop" title="Stop Recording">&#9632;</button>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #__meetrecord-overlay {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 999999;
        display: flex;
        align-items: center;
        gap: 6px;
        background: rgba(0,0,0,0.75);
        color: #fff;
        font-family: system-ui, sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 6px 12px;
        border-radius: 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        user-select: none;
        cursor: default;
      }
      #__mr-dot {
        width: 10px;
        height: 10px;
        background: #e53e3e;
        border-radius: 50%;
        animation: __mr-pulse 1.2s ease-in-out infinite;
      }
      @keyframes __mr-pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.3; }
      }
      #__mr-stop {
        background: none;
        border: 1px solid rgba(255,255,255,0.4);
        color: #fff;
        border-radius: 4px;
        padding: 2px 6px;
        cursor: pointer;
        font-size: 12px;
        margin-left: 4px;
      }
      #__mr-stop:hover { background: rgba(255,255,255,0.15); }
    `;

    document.head.appendChild(style);
    document.body.appendChild(overlay);

    document.getElementById('__mr-stop').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    });
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
    clearInterval(timerInterval);
    timerInterval = null;
    recordingStart = null;
  }

  function updateTimer() {
    if (!recordingStart) return;
    const elapsed = Date.now() - recordingStart;
    const h = Math.floor(elapsed / 3_600_000);
    const m = Math.floor((elapsed % 3_600_000) / 60_000);
    const s = Math.floor((elapsed % 60_000) / 1000);
    const fmt = (n) => String(n).padStart(2, '0');
    const el = document.getElementById('__mr-timer');
    if (el) el.textContent = `${fmt(h)}:${fmt(m)}:${fmt(s)}`;
  }

  // ─── Consent Banner ───────────────────────────────────────────────────────

  function showConsentBanner(platform, onAccept, onDecline) {
    if (document.getElementById('__mr-consent')) return;

    const banner = document.createElement('div');
    banner.id = '__mr-consent';
    banner.innerHTML = `
      <p><strong>MeetRecord</strong> wants to record this ${platform} meeting.</p>
      <div>
        <button id="__mr-accept">Allow Recording</button>
        <button id="__mr-decline">Decline</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #__mr-consent {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 999999;
        background: #fff;
        color: #1a202c;
        padding: 16px 24px;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.25);
        font-family: system-ui, sans-serif;
        font-size: 14px;
        max-width: 400px;
        text-align: center;
      }
      #__mr-consent p { margin: 0 0 12px; }
      #__mr-consent div { display: flex; gap: 10px; justify-content: center; }
      #__mr-accept {
        background: #3b82f6; color: #fff; border: none;
        padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 14px;
      }
      #__mr-decline {
        background: #e5e7eb; color: #374151; border: none;
        padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 14px;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(banner);

    document.getElementById('__mr-accept').onclick = () => { banner.remove(); onAccept(); };
    document.getElementById('__mr-decline').onclick = () => { banner.remove(); onDecline(); };
  }

  // ─── Message listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'RECORDING_STARTED') {
      recordingStart = Date.now();
      createOverlay();
      timerInterval = setInterval(updateTimer, 1000);
    }

    if (message.type === 'RECORDING_STOPPED') {
      removeOverlay();
    }
  });

  // Expose helpers to platform scripts
  window.__meetRecordCommon = { showConsentBanner };
})();
