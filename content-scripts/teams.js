/**
 * content-scripts/teams.js
 * Microsoft Teams (web) — meeting detection and metadata extraction.
 */

(function () {
  'use strict';

  // ─── Metadata extraction ────────────────────────────────────────────────

  function getMeetingTitle() {
    return (
      document.querySelector('[data-tid="meeting-title"], [class*="meeting-title"]')?.textContent?.trim() ??
      document.querySelector('h1')?.textContent?.trim() ??
      document.title.replace(' | Microsoft Teams', '').trim() ??
      'Teams Meeting'
    );
  }

  function isInMeeting() {
    // Teams renders a call stage with video/audio controls
    return !!(
      document.querySelector('[data-tid="call-stage"]') ||
      document.querySelector('[data-tid="toggle-video"]') ||
      document.querySelector('[class*="calling-unified-bar"]') ||
      document.querySelector('[id*="hangup-btn"]')
    );
  }

  // ─── Detection ──────────────────────────────────────────────────────────

  let detectedMeeting = false;

  function notifyMeetingDetected() {
    if (detectedMeeting) return;
    detectedMeeting = true;

    chrome.runtime.sendMessage({
      type: 'MEETING_DETECTED',
      platform: 'teams',
      meetingTitle: getMeetingTitle(),
      url: window.location.href,
      autoRecord: true,
    });

    observeForEnd();
  }

  function notifyMeetingEnded() {
    if (!detectedMeeting) return;
    detectedMeeting = false;
    chrome.runtime.sendMessage({ type: 'MEETING_ENDED', platform: 'teams' });
  }

  // Teams shows a post-call screen when the call ends
  function observeForEnd() {
    const observer = new MutationObserver(() => {
      // Call stage disappears after the meeting ends
      if (!document.querySelector('[data-tid="call-stage"], [class*="calling-unified-bar"]')) {
        const ended = document.querySelector('[data-tid="post-call"], [class*="end-of-call"]');
        if (ended || !isInMeeting()) {
          notifyMeetingEnded();
          observer.disconnect();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function pollForMeeting() {
    if (isInMeeting()) {
      notifyMeetingDetected();
    } else {
      setTimeout(pollForMeeting, 2500);
    }
  }

  // ─── Boot ────────────────────────────────────────────────────────────────

  // Teams is a heavy SPA; wait for the app shell to mount
  setTimeout(pollForMeeting, 5000);

  // Also watch for URL changes (Teams uses hash routing)
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      if (!isInMeeting()) {
        detectedMeeting = false;
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
