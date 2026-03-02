const status = document.getElementById('status');

navigator.mediaDevices.getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = '✓ Access granted — you can close this tab.';
    status.className = 'status ok';
    setTimeout(() => window.close(), 800);
  })
  .catch((err) => {
    status.textContent = `Denied: ${err.message}. Close this tab and try again.`;
    status.className = 'status err';
  });
