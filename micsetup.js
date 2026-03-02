const statusEl = document.getElementById('status');

navigator.mediaDevices.getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    chrome.storage.local.set({ micPermissionGranted: true });
    statusEl.textContent = '✓ Access granted — you can close this tab.';
    statusEl.className = 'status ok';
    setTimeout(() => window.close(), 1000);
  })
  .catch((err) => {
    statusEl.textContent = `Denied: ${err.message}. Close this tab and try again.`;
    statusEl.className = 'status err';
  });
