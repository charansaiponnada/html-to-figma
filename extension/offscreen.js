// Service workers have no clipboard or blob URLs; this hidden page does both.
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.target !== 'offscreen') return;
  try {
    if (msg.type === 'copy') {
      const t = document.getElementById('t');
      t.value = msg.text;
      t.select();
      const ok = document.execCommand('copy');
      t.value = '';
      send(ok ? { ok: true } : { ok: false, error: 'The browser refused the clipboard write. Use "Download .json" instead.' });
    } else if (msg.type === 'blob') {
      send({ ok: true, url: URL.createObjectURL(new Blob([msg.text], { type: 'application/json' })) });
    } else if (msg.type === 'revoke') {
      URL.revokeObjectURL(msg.url);
      send({ ok: true });
    }
  } catch (e) {
    send({ ok: false, error: e.message });
  }
});
