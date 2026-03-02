navigator.mediaDevices.getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    window.parent.postMessage('MIC_GRANTED', '*');
  })
  .catch(() => {
    window.parent.postMessage('MIC_DENIED', '*');
  });
