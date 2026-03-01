/**
 * content-scripts/zoom.js
 * Zoom Web Client — meeting detection and metadata extraction.
 * Covers zoom.us/wc/<id> and zoom.us/j/<id>
 */

(function () {
  'use strict';

  const ZOOM_WC_RE = /zoom\.us\/(wc|j)\/(\d+)/;

  // ─── Metadata extraction ────────────────────────────────────────────────

  function getMeetingId() {
    const m = window.location.href.match(ZOOM_WC_RE);
    return m ? m[2] : null;
  }

  function getMeetingTitle() {
    // Zoom puts the topic in the document title or a header element
    return document.querySelector('.meeting-topic')?.textContent?.trim()
      ?? document.querySelector('[class*="meeting-title"]')?.textContent?.trim()
      ?? `Zoom Meeting ${getMeetingId()}`;
  }

  function isInMeeting() {
    // The main meeting container is present when inside an active call
    return !!(
      document.querySelector('#webclient') ||
      document.querySelector('.meeting-client-inner') ||
      document.querySelector('[class*="zm-modal-body-title"]') === null && // not on modal
      document.querySelector('[class*="footer__btns-right"]')
    );
  }

  // ─── Detection ──────────────────────────────────────────────────────────

  let detectedMeeting = false;

  function notifyMeetingDetected() {
    if (detectedMeeting) return;
    detectedMeeting = true;

    chrome.runtime.sendMessage({
      type: 'MEETING_DETECTED',
      platform: 'zoom',
      meetingId: getMeetingId(),
      meetingTitle: getMeetingTitle(),
      url: window.location.href,
      autoRecord: true,
    });

    observeForEnd();
  }

  function notifyMeetingEnded() {
    if (!detectedMeeting) return;
    detectedMeeting = false;
    chrome.runtime.sendMessage({ type: 'MEETING_ENDED', platform: 'zoom' });
  }

  // Zoom renders a "The meeting has ended" overlay
  function observeForEnd() {
    const observer = new MutationObserver(() => {
      const endScreen = document.querySelector(
        '[class*="meeting-ended"], [class*="LeaveConfirm"], .meeting-end-reason'
      );
      if (endScreen) {
        notifyMeetingEnded();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function pollForMeeting() {
    if (isInMeeting()) {
      notifyMeetingDetected();
    } else {
      setTimeout(pollForMeeting, 2000);
    }
  }

  // ─── Boot ────────────────────────────────────────────────────────────────

  if (ZOOM_WC_RE.test(window.location.href)) {
    // Zoom's SPA loads asynchronously; give it time to render
    setTimeout(pollForMeeting, 3000);
  }
})();
