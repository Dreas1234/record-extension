/**
 * content-scripts/meet.js
 * Google Meet — meeting detection, metadata extraction, and auto-record trigger.
 */

(function () {
  'use strict';

  const PLATFORM = 'Google Meet';

  // ─── Meeting detection ──────────────────────────────────────────────────

  // Meet uses URL pattern: meet.google.com/xxx-xxxx-xxx
  const MEETING_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/;

  function isInMeeting() {
    return MEETING_URL_RE.test(window.location.href) &&
      !!document.querySelector('[data-call-ended="false"], [jsname="Qx7uuf"]');
  }

  function getMeetingCode() {
    return window.location.pathname.slice(1); // e.g. "abc-defg-hij"
  }

  function getMeetingTitle() {
    return document.querySelector('c-wiz[data-p] [jsname="r4nke"]')?.textContent?.trim()
      ?? document.title.replace(' - Google Meet', '').trim()
      ?? getMeetingCode();
  }

  function getParticipantCount() {
    const badge = document.querySelector('[data-count]');
    return badge ? parseInt(badge.dataset.count, 10) : null;
  }

  // ─── Observer ───────────────────────────────────────────────────────────

  let detectedMeeting = false;
  let meetingEndObserver = null;

  function notifyMeetingDetected() {
    if (detectedMeeting) return;
    detectedMeeting = true;

    const metadata = {
      platform: 'google_meet',
      meetingCode: getMeetingCode(),
      meetingTitle: getMeetingTitle(),
      participantCount: getParticipantCount(),
      url: window.location.href,
    };

    chrome.runtime.sendMessage({
      type: 'MEETING_DETECTED',
      ...metadata,
      autoRecord: true,
    });

    observeMeetingEnd();
  }

  function notifyMeetingEnded() {
    if (!detectedMeeting) return;
    detectedMeeting = false;
    meetingEndObserver?.disconnect();
    chrome.runtime.sendMessage({ type: 'MEETING_ENDED', platform: 'google_meet' });
  }

  // Watch for the "You left the call" screen or URL change
  function observeMeetingEnd() {
    meetingEndObserver = new MutationObserver(() => {
      if (!MEETING_URL_RE.test(window.location.href)) {
        notifyMeetingEnded();
        return;
      }
      // Meet shows a post-call screen with a rejoin button
      const leftCall = document.querySelector('[data-call-ended="true"], [jsname="CQylAd"]');
      if (leftCall) notifyMeetingEnded();
    });

    meetingEndObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
  }

  // Polling fallback for initial detection
  function pollForMeeting() {
    if (isInMeeting()) {
      notifyMeetingDetected();
    } else {
      setTimeout(pollForMeeting, 2000);
    }
  }

  // ─── Boot ────────────────────────────────────────────────────────────────

  if (MEETING_URL_RE.test(window.location.href)) {
    // Wait for the meeting UI to render before polling
    if (document.readyState === 'complete') {
      pollForMeeting();
    } else {
      window.addEventListener('load', pollForMeeting);
    }
  }

  // Handle single-page navigation
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      detectedMeeting = false;
      if (MEETING_URL_RE.test(lastUrl)) {
        setTimeout(pollForMeeting, 1500);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
