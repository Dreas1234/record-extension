/**
 * content-scripts/mic-prompt.js
 * Handles microphone permission requests from the popup.
 * Running inside the real tab means Chrome shows the proper mic dialog.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'REQUEST_MIC_PERMISSION') return;

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      stream.getTracks().forEach((t) => t.stop());
      sendResponse({ granted: true });
    })
    .catch((err) => {
      sendResponse({ granted: false, error: err.message });
    });

  return true; // keep message channel open for async response
});
