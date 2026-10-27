const DEFAULTS = { mode: 'full', lazyLoad: true, simplify: true, autoLayout: false, output: 'svg' };
const form = document.getElementById('f');
const status = document.getElementById('status');
const go = document.getElementById('go');

chrome.storage.local.get('settings').then(({ settings }) => {
  const o = { ...DEFAULTS, ...settings };
  for (const el of form.elements) {
    if (el.type === 'radio') el.checked = o[el.name] === el.value;
    else if (el.type === 'checkbox') el.checked = !!o[el.name];
  }
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const opts = {};
  for (const el of form.elements) {
    if (el.type === 'radio' && el.checked) opts[el.name] = el.value;
    else if (el.type === 'checkbox') opts[el.name] = el.checked;
  }
  await chrome.storage.local.set({ settings: opts });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const reply = chrome.runtime.sendMessage({ type: 'capture', tabId: tab.id, opts });
  if (opts.mode === 'pick') return window.close(); // the page needs focus so you can click an element
  go.disabled = true;
  status.className = '';
  status.textContent = 'Capturing… (you can close this popup)';
  try {
    const res = await reply;
    status.className = res && res.ok ? '' : 'error';
    status.textContent = res ? (res.ok ? res.message : res.error || 'Cancelled') : 'No response';
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
  } finally {
    go.disabled = false;
  }
});
