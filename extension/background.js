// Runs a capture in the tab, fetches its images (host permission = no CORS), then copies or downloads the result.
importScripts('svg.js');
const DEFAULTS = { mode: 'full', lazyLoad: true, simplify: true, autoLayout: false, output: 'svg' };
const MAX_IMAGE = 10e6; // bytes per image
const MAX_IMAGES = 30e6; // bytes for all images; extension messages cap out at 64 MB
const MAX_PAYLOAD = 60e6; // characters

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type !== 'capture') return;
  run(msg.tabId, { ...DEFAULTS, ...msg.opts }).then(send, e => send({ ok: false, error: e.message || String(e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'capture-page' || !tab) return;
  const { settings } = await chrome.storage.local.get('settings');
  const o = { ...DEFAULTS, ...settings };
  if (o.mode === 'pick') o.mode = 'full';
  run(tab.id, o).catch(() => {});
});

const running = new Set();

async function run(tabId, opts) {
  if (running.has(tabId)) throw new Error('A capture is already running in this tab.');
  running.add(tabId);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js'] });
    toast(tabId, opts.mode === 'pick' ? 'Click an element to copy  ·  ↑ selects the parent  ·  Esc cancels' : 'Capturing page…');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: o => window.__h2f.capture(o), args: [opts] });
    if (!result) throw new Error('The page returned nothing. Reload it and try again.');
    if (result.cancelled) { toast(tabId, 'Cancelled', 'info'); return { ok: false, cancelled: true }; }

    await fetchImages(result.images, (done, total) => toast(tabId, `Downloading images ${done}/${total}…`));
    if (opts.output === 'svg') {
      toast(tabId, 'Building layers…');
      await pool(Object.values(result.images), 4, figmaSafeImage);
    }
    let text = opts.output === 'svg' ? toFigmaSvg(result) : JSON.stringify(result);
    if (text.length > MAX_PAYLOAD) throw new Error('This page is too large to copy. Try "Visible area" or "Pick an element".');

    const name = (result.source.title || 'page').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'page';
    if (opts.output === 'download') await download(text, `${name}.figma.json`);
    else await copy(text);
    text = null;

    const failed = Object.values(result.images).filter(i => i.error).length;
    const next = { svg: 'Click the Figma canvas and press Ctrl+V (⌘V on Mac).', copy: 'In Figma, run the "HTML to Figma" plugin and press Ctrl+V.', download: 'Drop the file onto the "HTML to Figma" plugin window.' }[opts.output];
    const msg = `${opts.output === 'download' ? 'Saved' : 'Copied'}! ${next}` +
      (failed ? `  (${failed} image${failed > 1 ? 's' : ''} couldn't be loaded)` : '') +
      (result.stats.truncated ? '  (page was cut short: too many elements)' : '');
    toast(tabId, msg, 'done');
    return { ok: true, message: msg };
  } catch (e) {
    const message = /Cannot access|cannot be scripted|chrome:\/\/|Missing host permission/i.test(e.message)
      ? 'Chrome doesn\'t allow extensions on this page (browser pages, the Web Store, PDFs).'
      : e.message;
    toast(tabId, message, 'error');
    throw new Error(message);
  } finally {
    running.delete(tabId);
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function fetchImages(images, progress) {
  const ids = Object.keys(images).filter(id => !images[id].data && !images[id].svg && !images[id].error);
  let budget = MAX_IMAGES, done = 0;
  await pool(ids, 6, async id => {
    const im = images[id];
    try {
      const res = await fetch(im.url, { signal: AbortSignal.timeout(15000), credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const head = new TextDecoder().decode(await blob.slice(0, 256).arrayBuffer()).trimStart();
      if (blob.type.includes('svg') || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) im.svg = await blob.text();
      else {
        if (blob.size > MAX_IMAGE || blob.size > budget) throw new Error('too large');
        budget -= blob.size;
        im.data = `data:${blob.type || 'application/octet-stream'};base64,` + b64(new Uint8Array(await blob.arrayBuffer()));
      }
    } catch (e) {
      im.error = e.name === 'TimeoutError' ? 'timed out' : e.message || String(e);
    }
    done++;
    if (done % 5 === 0 || done === ids.length) progress(done, ids.length);
  });
}

// Figma's SVG import reads PNG, JPEG and GIF up to 4096px; convert anything else (WebP, AVIF, huge photos) to PNG.
async function figmaSafeImage(im) {
  if (!im.data) return;
  try {
    const bmp = await createImageBitmap(await (await fetch(im.data)).blob());
    const s = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    if (s === 1 && /^data:image\/(png|jpe?g|gif)/.test(im.data)) return bmp.close();
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const out = await c.convertToBlob({ type: 'image/png' });
    im.data = 'data:image/png;base64,' + b64(new Uint8Array(await out.arrayBuffer()));
  } catch (e) {
    delete im.data;
    im.error = 'unsupported image';
  }
}

async function offscreen(msg) {
  const has = (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length;
  if (!has) {
    try {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD', 'BLOBS'], justification: 'Copy the captured page to the clipboard' });
    } catch (e) {
      if (!/single offscreen/i.test(e.message)) throw e;
    }
  }
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Clipboard write failed');
  return res;
}

const copy = text => offscreen({ type: 'copy', text });

async function download(text, filename) {
  const { url } = await offscreen({ type: 'blob', text });
  await chrome.downloads.download({ url, filename, saveAs: false });
  setTimeout(() => offscreen({ type: 'revoke', url }).catch(() => {}), 60000);
}

function toast(tabId, text, kind = '') {
  chrome.scripting.executeScript({
    target: { tabId },
    args: [text, kind],
    func: (text, kind) => {
      let el = document.getElementById('__h2f_toast');
      if (!el) {
        el = document.createElement('div');
        el.id = '__h2f_toast';
        el.setAttribute('data-h2f-ui', '');
        el.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));' +
          'padding:10px 16px;border-radius:8px;color:#fff;font:500 13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;';
        document.documentElement.append(el);
      }
      el.textContent = text;
      el.style.background = kind === 'error' ? '#c62828' : kind === 'done' ? '#0d7a3f' : '#1e1e1e';
      clearTimeout(window.__h2fToastTimer);
      if (kind) window.__h2fToastTimer = setTimeout(() => el.remove(), kind === 'error' ? 8000 : 5000);
    },
  }).catch(() => {});
}
