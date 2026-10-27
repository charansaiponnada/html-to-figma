// Injected into the page. Turns the rendered DOM into a layer tree that the Figma plugin rebuilds.
// All coordinates in the output are CSS px relative to the capture origin (page, viewport or picked element).
(() => {
  if (window.__h2f) return;

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'datalist']);
  const REPLACED = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'input', 'textarea', 'select', 'button', 'object', 'embed', 'audio', 'picture', 'math']);
  const NO_PSEUDO = new Set(['img', 'input', 'textarea', 'select', 'video', 'canvas', 'iframe', 'svg', 'br', 'option', 'audio', 'embed', 'object']);
  const UI_ATTR = 'data-h2f-ui';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_FONT = /icon|awesome|material symbols|glyph|feather|ionicons|remixicon|bootstrap-icons|dashicons|fontello|icomoon/i;

  let opts, bounds, state, rng, scratch;

  const rnd = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getCS = (el, pseudo) => el.ownerDocument.defaultView.getComputedStyle(el, pseudo);
  const px = v => parseFloat(v) || 0;

  // ---------- colors ----------
  const colorCache = new Map();
  // Returns {r,g,b,a} in 0..1, or null if the browser can't parse it. Alpha 0 is returned, not dropped.
  function parseColor(str) {
    if (!str || str === 'none' || str === 'auto' || str === 'currentcolor') return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let c;
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      c = { r: m[1] / 255, g: m[2] / 255, b: m[3] / 255, a };
    } else if (str === 'transparent') {
      c = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      // oklch(), color(), hsl() and friends: let a canvas resolve whatever the browser understands.
      scratch ||= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      scratch.clearRect(0, 0, 1, 1);
      scratch.fillStyle = '#01020300';
      scratch.fillStyle = str;
      if (scratch.fillStyle === '#01020300' || scratch.fillStyle === 'rgba(1, 2, 3, 0)') { colorCache.set(str, null); return null; }
      scratch.fillRect(0, 0, 1, 1);
      const d = scratch.getImageData(0, 0, 1, 1).data;
      c = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
    }
    const r4 = v => Math.round(v * 1e4) / 1e4;
    c = { r: r4(c.r), g: r4(c.g), b: r4(c.b), a: r4(c.a) };
    colorCache.set(str, c);
    return c;
  }
  const shows = c => c && c.a > 0;

  // Split on commas that are not inside parentheses.
  function splitTop(s) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  const COLOR_RE = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|#[0-9a-f]{3,8}\b/i;

  function parseShadows(str, isText) {
    if (!str || str === 'none') return [];
    const out = [];
    for (const s of splitTop(str)) {
      const cm = s.match(COLOR_RE);
      const color = parseColor(cm ? cm[0] : 'black');
      const rest = cm ? s.replace(cm[0], ' ') : s;
      const n = rest.split(/\s+/).filter(t => /^-?[\d.]+(px)?$/.test(t)).map(parseFloat);
      if (!shows(color)) continue;
      out.push({ type: 'SHADOW', inset: /\binset\b/.test(rest), x: rnd(n[0] || 0), y: rnd(n[1] || 0), blur: rnd(n[2] || 0), spread: isText ? 0 : rnd(n[3] || 0), color });
    }
    return out;
  }

  // ---------- gradients ----------
  function toDeg(v) {
    const n = parseFloat(v);
    if (v.endsWith('grad')) return n * 0.9;
    if (v.endsWith('rad')) return (n * 180) / Math.PI;
    if (v.endsWith('turn')) return n * 360;
    return n;
  }
  function sideAngle(s, w, h) {
    const t = /top/.test(s), b = /bottom/.test(s), l = /left/.test(s), r = /right/.test(s);
    if ((t || b) && (l || r)) {
      const a = (Math.atan2(h, w) * 180) / Math.PI; // "to top right" for a w×h box
      if (t && r) return a;
      if (b && r) return 180 - a;
      if (b && l) return 180 + a;
      return 360 - a;
    }
    return t ? 0 : r ? 90 : b ? 180 : 270;
  }
  function parseStop(a) {
    const m = a.match(/^((?:[a-z-]+)\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)\s*(.*)$/i);
    if (!m) return null;
    const color = parseColor(m[1]);
    if (!color) return null;
    return { color, pos: m[2].split(/\s+/).filter(Boolean) };
  }
  function parseGradient(s, w, h) {
    const m = s.match(/^(?:repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s);
    if (!m) return null;
    const kind = m[1];
    const args = splitTop(m[2]);
    let angle = 180;
    const first = args[0].replace(/\bin\s+[a-z-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?/g, '').trim();
    if (!parseStop(first)) {
      args.shift();
      if (kind === 'linear') {
        if (/^-?[\d.]+(deg|rad|turn|grad)$/.test(first)) angle = toDeg(first);
        else if (first.startsWith('to ')) angle = sideAngle(first, w, h);
      }
    }
    const rad = (angle * Math.PI) / 180;
    const len = kind === 'linear' ? Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)) || 1 : Math.hypot(w, h) / 2 || 1;
    const stops = [];
    for (const a of args) {
      const st = parseStop(a);
      if (!st) continue; // colour hints like "50%"
      const posOf = p => (p.endsWith('%') ? parseFloat(p) / 100 : p.endsWith('px') ? parseFloat(p) / len : p.endsWith('deg') ? parseFloat(p) / 360 : NaN);
      if (!st.pos.length) stops.push({ color: st.color, pos: NaN });
      else for (const p of st.pos.slice(0, 2)) stops.push({ color: st.color, pos: posOf(p) });
    }
    if (!stops.length) return null;
    if (stops.length === 1) stops.push({ ...stops[0], pos: 1 });
    // Fill in missing positions the way CSS does: ends at 0 and 1, gaps spread evenly, never decreasing.
    if (isNaN(stops[0].pos)) stops[0].pos = 0;
    if (isNaN(stops[stops.length - 1].pos)) stops[stops.length - 1].pos = 1;
    for (let i = 1; i < stops.length; i++) {
      if (!isNaN(stops[i].pos)) { stops[i].pos = Math.max(stops[i].pos, stops[i - 1].pos); continue; }
      let j = i;
      while (isNaN(stops[j].pos)) j++;
      const a = stops[i - 1].pos, b = stops[j].pos;
      for (let k = i; k < j; k++) stops[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
    // A transparent stop should fade the neighbour's colour, not fade through black.
    stops.forEach((st, i) => {
      if (st.color.a > 0) return;
      const nb = stops.slice(i + 1).find(x => x.color.a > 0) || stops.slice(0, i).reverse().find(x => x.color.a > 0);
      if (nb) st.color = { ...nb.color, a: 0 };
    });
    return {
      type: kind === 'linear' ? 'LINEAR' : kind === 'radial' ? 'RADIAL' : 'ANGULAR',
      angle: rnd(angle),
      stops: stops.map(st => ({ pos: rnd(Math.min(1, Math.max(0, st.pos)) * 1000) / 1000, color: st.color })),
    };
  }

  // ---------- images ----------
  function regImage(url, use) {
    if (!url) return null;
    let id = state.urlIds.get(url);
    if (!id) {
      id = 'i' + state.urlIds.size;
      state.urlIds.set(url, id);
      state.images[id] = { url };
    }
    state.images[id][use] = true;
    return id;
  }
  function bgScale(size, repeat) {
    if (size === 'cover') return 'FILL';
    if (size === 'contain') return 'FIT';
    if (size === '100% 100%') return 'STRETCH';
    if (/^auto( auto)?$/.test(size) && !/no-repeat/.test(repeat)) return 'TILE';
    return 'FILL';
  }
  const fitScale = f => ({ cover: 'FILL', contain: 'FIT', 'scale-down': 'FIT', none: 'FIT' })[f] || 'STRETCH';

  // Draws text with the page's own (web) font. Used for icon fonts, which Figma won't have.
  function rasterText(text, cs, w, h) {
    if (w < 1 || h < 1) return null;
    const c = document.createElement('canvas');
    const s = 3;
    c.width = Math.ceil(w * s);
    c.height = Math.ceil(h * s);
    const g = c.getContext('2d');
    g.scale(s, s);
    g.font = fontShorthand(cs);
    g.fillStyle = cs.color;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillText(text, w / 2, h / 2);
    try { return c.toDataURL('image/png'); } catch { return null; }
  }
  const fontShorthand = cs => `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  function measureText(text, cs) {
    scratch ||= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    scratch.font = fontShorthand(cs);
    return scratch.measureText(text).width + px(cs.letterSpacing) * text.length;
  }

  // ---------- box styles ----------
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
  function contentBox(cs, b) {
    const l = px(cs.borderLeftWidth) + px(cs.paddingLeft), t = px(cs.borderTopWidth) + px(cs.paddingTop);
    const r = px(cs.borderRightWidth) + px(cs.paddingRight), bt = px(cs.borderBottomWidth) + px(cs.paddingBottom);
    return { x: rnd(b.x + l), y: rnd(b.y + t), w: rnd(Math.max(0, b.w - l - r)), h: rnd(Math.max(0, b.h - t - bt)) };
  }

  function boxStyle(cs, box) {
    const s = { fills: [] };
    const clipText = (cs.backgroundClip || cs.webkitBackgroundClip) === 'text';
    if (!clipText) {
      const bg = parseColor(cs.backgroundColor);
      if (shows(bg)) s.fills.push({ type: 'SOLID', color: bg });
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const layers = splitTop(cs.backgroundImage);
        const sizes = splitTop(cs.backgroundSize || ''), repeats = splitTop(cs.backgroundRepeat || '');
        // CSS lists the top layer first; Figma paints the last fill on top.
        for (let i = layers.length - 1; i >= 0; i--) {
          const u = layers[i].match(/^url\(\s*["']?(.*?)["']?\s*\)$/);
          if (u) s.fills.push({ type: 'IMAGE', image: regImage(u[1], 'fill'), scale: bgScale(sizes[i] || 'auto', repeats[i] || 'repeat') });
          else {
            const g = parseGradient(layers[i], box.w, box.h);
            if (g) s.fills.push(g);
          }
        }
      }
    }
    const styles = SIDES.map(sd => cs[`border${sd}Style`]);
    const weights = SIDES.map((sd, i) => (styles[i] === 'none' || styles[i] === 'hidden' ? 0 : rnd(px(cs[`border${sd}Width`]))));
    const side = weights.findIndex(Boolean);
    if (side >= 0) {
      const c = parseColor(cs[`border${SIDES[side]}Color`]);
      if (shows(c)) s.stroke = { color: c, weights, style: styles[side] };
    }
    const rad = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(k => {
      const v = (cs[`border${k}Radius`] || '0').split(' ')[0];
      const n = v.endsWith('%') ? (parseFloat(v) / 100) * Math.min(box.w, box.h) : px(v);
      return rnd(Math.min(n, Math.min(box.w, box.h) / 2));
    });
    if (rad.some(Boolean)) s.radius = rad;
    const effects = parseShadows(cs.boxShadow);
    const blur = (cs.filter || '').match(/blur\(([\d.]+)px\)/);
    if (blur) effects.push({ type: 'LAYER_BLUR', radius: rnd(parseFloat(blur[1]) * 2) });
    for (const ds of (cs.filter || '').matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)) effects.push(...parseShadows(ds[1], true));
    const bblur = (cs.backdropFilter || cs.webkitBackdropFilter || '').match(/blur\(([\d.]+)px\)/);
    if (bblur) effects.push({ type: 'BACKGROUND_BLUR', radius: rnd(parseFloat(bblur[1]) * 2) });
    if (effects.length) s.effects = effects;
    if (/hidden|clip|auto|scroll/.test(cs.overflowX + cs.overflowY)) s.clip = true;
    return s;
  }

  function common(node, cs) {
    const op = parseFloat(cs.opacity);
    if (op < 1) node.opacity = rnd(op);
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') node.blend = cs.mixBlendMode.toUpperCase().replace('-', '_');
    if (cs.position === 'absolute' || cs.position === 'fixed') node.abs = 1;
    const z = parseInt(cs.zIndex, 10);
    // Rough CSS paint order: negative z, in-flow, positioned auto/0, positive z.
    node.z = cs.position === 'static' ? 0 : isNaN(z) || z === 0 ? 0.5 : z < 0 ? z : z + 1;
    return node;
  }

  // ---------- text ----------
  function fontFamilies(str) {
    return splitTop(str || '').map(f => f.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  }
  function clipTextColor(el) {
    for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) {
      const c = getCS(e);
      if ((c.backgroundClip || c.webkitBackgroundClip) === 'text' && c.backgroundImage !== 'none') {
        const g = parseGradient(splitTop(c.backgroundImage)[0], 100, 100);
        if (g) return g.stops[0].color;
      }
    }
    return null;
  }
  function runStyle(cs, el) {
    let color = parseColor(cs.webkitTextFillColor) || parseColor(cs.color);
    if (!shows(color)) color = clipTextColor(el) || color;
    const deco = cs.textDecorationLine || '';
    return {
      font: { families: fontFamilies(cs.fontFamily), weight: parseInt(cs.fontWeight, 10) || 400, italic: cs.fontStyle !== 'normal' },
      size: rnd(px(cs.fontSize)),
      color,
      lineHeight: cs.lineHeight === 'normal' ? null : rnd(px(cs.lineHeight)),
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : rnd(px(cs.letterSpacing)),
      decoration: deco.includes('underline') ? 'UNDERLINE' : deco.includes('line-through') ? 'STRIKETHROUGH' : 'NONE',
      textCase: { uppercase: 'UPPER', lowercase: 'LOWER', capitalize: 'TITLE' }[cs.textTransform] || 'ORIGINAL',
      ...fontMetrics(cs),
    };
  }
  // Ascent/descent of the font as rendered, so SVG text can sit on the same baseline as the page.
  const metricCache = new Map();
  function fontMetrics(cs) {
    const f = fontShorthand(cs);
    if (!metricCache.has(f)) {
      scratch ||= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      scratch.font = f;
      const m = scratch.measureText('Hg'), size = px(cs.fontSize);
      metricCache.set(f, { asc: rnd(m.fontBoundingBoxAscent || size * 0.8), desc: rnd(m.fontBoundingBoxDescent || size * 0.2) });
    }
    return metricCache.get(f);
  }
  // Character offsets where the browser wrapped the text onto a new line.
  function lineBreaks(text, target, lh) {
    const doc = target.ownerDocument, r = doc.createRange();
    const tops = [];
    let joined = false; // previous text node ended mid-word, so the next one continues that word
    const visit = tn => {
      for (const m of tn.data.matchAll(/\S+/g)) {
        if (m.index === 0 && joined) continue;
        r.setStart(tn, m.index);
        r.setEnd(tn, m.index + 1);
        const rc = r.getClientRects()[0];
        if (rc && rc.height) tops.push(rc.top);
      }
      joined = /\S$/.test(tn.data);
    };
    if (target.nodeType === 3) visit(target);
    else {
      const tw = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      while (tw.nextNode()) {
        const n = tw.currentNode;
        if (n.nodeType === 3) visit(n);
        else if (n.localName === 'br') joined = false;
      }
    }
    const words = [...text.matchAll(/\S+/g)];
    if (words.length !== tops.length) return null; // hidden or shadow-DOM text: can't line them up safely
    const out = [];
    for (let i = 1; i < words.length; i++) {
      const gap = text.slice(words[i - 1].index + words[i - 1][0].length, words[i].index);
      if (tops[i] - tops[i - 1] > lh * 0.5 && !gap.includes('\n')) out.push(words[i].index);
    }
    return out;
  }
  function styleId(st) {
    const key = JSON.stringify(st);
    let id = state.styleIds.get(key);
    if (id === undefined) {
      id = state.styles.length;
      state.styles.push(st);
      state.styleIds.set(key, id);
    }
    return id;
  }
  const alignOf = cs => ({ center: 'CENTER', '-webkit-center': 'CENTER', right: 'RIGHT', end: 'RIGHT', '-webkit-right': 'RIGHT', justify: 'JUSTIFIED' })[cs.textAlign] || 'LEFT';
  const collapseMode = cs => cs.whiteSpaceCollapse || ({ normal: 'collapse', nowrap: 'collapse', 'pre-line': 'preserve-breaks' })[cs.whiteSpace] || 'preserve';

  function kids(el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (el.localName === 'slot') {
      const a = el.assignedNodes({ flatten: true });
      return a.length ? a : el.childNodes;
    }
    return el.childNodes;
  }

  function hasBox(c) {
    return shows(parseColor(c.backgroundColor)) || c.backgroundImage !== 'none' || px(c.borderTopWidth) + px(c.borderLeftWidth) + px(c.borderRightWidth) + px(c.borderBottomWidth) > 0 ||
      c.boxShadow !== 'none' || c.position === 'absolute' || c.position === 'fixed' || parseFloat(c.opacity) < 1;
  }

  // True when the element holds only text and plain inline elements, so it can become one rich-text layer.
  function isTextBlock(el, cs) {
    if (/flex|grid/.test(cs.display)) return false;
    let hasText = false;
    const ok = e => {
      for (const ch of kids(e)) {
        if (ch.nodeType === 3) { if (ch.data.trim()) hasText = true; continue; }
        if (ch.nodeType !== 1 || ch.localName === 'br' || SKIP.has(ch.localName)) continue;
        const c = getCS(ch);
        if (c.display === 'none') continue;
        if (c.display !== 'inline' || REPLACED.has(ch.localName) || ch.shadowRoot || hasBox(c)) return false;
        for (const w of ['::before', '::after']) { const p = getCS(ch, w).content; if (p && p !== 'none' && p !== 'normal') return false; }
        if (!ok(ch)) return false;
      }
      return true;
    };
    return ok(el) && hasText;
  }

  function collectRuns(el, cs, out) {
    for (const ch of kids(el)) {
      if (ch.nodeType === 3) out.push({ text: ch.data, mode: collapseMode(cs), el, cs });
      else if (ch.nodeType === 1 && !SKIP.has(ch.localName)) {
        if (ch.localName === 'br') { out.push({ text: '\n', mode: 'preserve', el, cs }); continue; }
        const c = getCS(ch);
        if (c.display !== 'none') collectRuns(ch, c, out);
      }
    }
    return out;
  }

  // Applies CSS white-space collapsing across run boundaries, then merges runs with identical styles.
  function normalizeRuns(raw) {
    const out = [];
    let prevSpace = true;
    const styleCache = new Map();
    for (const r of raw) {
      let t = r.text;
      const collapsible = r.mode === 'collapse' || r.mode === 'preserve-breaks';
      if (r.mode === 'collapse') t = t.replace(/[\t\n\r\f ]+/g, ' ');
      else if (r.mode === 'preserve-breaks') t = t.replace(/[\t\f\r ]+/g, ' ').replace(/ ?\n ?/g, '\n');
      if (collapsible && prevSpace) t = t.replace(/^ /, '');
      if (!t) continue;
      if (t[0] === '\n' && out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/ +$/, '');
      prevSpace = /[ \n]$/.test(t);
      if (!styleCache.has(r.el)) styleCache.set(r.el, styleId(runStyle(r.cs, r.el)));
      const style = styleCache.get(r.el);
      const last = out[out.length - 1];
      if (last && last.style === style) last.text += t;
      else out.push({ text: t, style, collapsible });
    }
    const last = out[out.length - 1];
    if (last && last.collapsible) last.text = last.text.replace(/ +$/, '');
    return out.filter(r => r.text).map(({ text, style }) => ({ text, style }));
  }

  function rectsOf(target) {
    rng ||= document.createRange();
    const r = target.ownerDocument === document ? rng : target.ownerDocument.createRange();
    r.selectNodeContents(target);
    return [...r.getClientRects()].filter(x => x.width > 0 && x.height > 0);
  }

  function textNode(runs, rangeTarget, alignCs, el, ctx) {
    if (!runs.length) return null;
    const text = runs.map(r => r.text).join('');
    if (!text.trim()) return null;
    const rects = rectsOf(rangeTarget);
    if (!rects.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) { x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
    const box = { x: rnd(x0 + ctx.offX), y: rnd(y0 + ctx.offY), w: rnd(x1 - x0), h: rnd(y1 - y0) };
    if (!intersects(box)) return null;
    const sorted = rects.map(r => r).sort((a, b) => a.top - b.top);
    let lines = 1, top = sorted[0].top;
    for (const r of sorted) if (r.top - top > r.height * 0.6) { lines++; top = r.top; }
    if (text.includes('\n')) lines = Math.max(lines, 2);
    const first = state.styles[runs[0].style];
    // Icon fonts render as tofu in Figma; capture them as pixels instead.
    if (runs.length === 1 && text.trim().length <= 3 && (ICON_FONT.test(first.font.families[0] || '') || /^[-\s]+$/.test(text))) {
      const url = rasterText(text.trim(), getCS(el), box.w, box.h);
      if (url) return { type: 'IMAGE', name: 'icon', ...box, image: regImage(url, 'node'), scale: 'FIT', fills: [] };
    }
    const node = { type: 'TEXT', name: text.trim().slice(0, 40), ...box, lines, align: alignOf(alignCs), runs };
    if (lines > 1) {
      const breaks = lineBreaks(text, rangeTarget, first.lineHeight || first.size * 1.2);
      if (breaks && breaks.length) node.breaks = breaks;
    }
    const ts = parseShadows(getCS(el).textShadow, true);
    if (ts.length) node.effects = ts;
    return node;
  }

  function textBlock(el, cs, ctx) {
    return textNode(normalizeRuns(collectRuns(el, cs, [])), el, cs, el, ctx);
  }

  // ---------- pseudo elements (measured, never inserted, so page selectors stay intact) ----------
  function pseudoText(content) {
    if (!/^(?:"(?:[^"\\]|\\.)*"\s*)+$/.test(content)) return null; // url(), counter(), attr()...
    return [...content.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map(m => m[1].replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch)))
      .join('');
  }
  function lastTextRect(el) {
    const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    while (tw.nextNode()) if (tw.currentNode.data.trim()) last = tw.currentNode;
    if (!last) return null;
    const r = rectsOf(last);
    return r[r.length - 1] || null;
  }
  function pseudoNode(el, cs, which, box, ctx) {
    const ps = getCS(el, which);
    const content = ps.content;
    if (!content || content === 'none' || content === 'normal' || ps.display === 'none' || ps.visibility !== 'visible') return null;
    const text = pseudoText(content);
    if (text === null) return null;
    const run = text.trim() ? runStyle(ps, el) : null;
    const hz = px(ps.paddingLeft) + px(ps.paddingRight) + px(ps.borderLeftWidth) + px(ps.borderRightWidth);
    const vt = px(ps.paddingTop) + px(ps.paddingBottom) + px(ps.borderTopWidth) + px(ps.borderBottomWidth);
    const contentSized = ps.boxSizing === 'content-box';
    let w = parseFloat(ps.width), h = parseFloat(ps.height);
    if (isNaN(w)) w = (run ? measureText(text, ps) : 0) + hz;
    else if (contentSized) w += hz;
    if (isNaN(h)) h = (run ? run.lineHeight || run.size * 1.2 : 0) + vt;
    else if (contentSized) h += vt;
    if (w <= 0 || h <= 0) return null;
    let x, y;
    const ml = px(ps.marginLeft), mt = px(ps.marginTop);
    if (ps.position === 'absolute' || ps.position === 'fixed') {
      let cb = { x: ctx.offX, y: ctx.offY };
      const cbEl = ps.position === 'fixed' ? null : cs.position !== 'static' ? el : el.offsetParent;
      if (cbEl) { const r = cbEl.getBoundingClientRect(); cb = { x: r.left + cbEl.clientLeft + ctx.offX, y: r.top + cbEl.clientTop + ctx.offY }; }
      const L = parseFloat(ps.left), T = parseFloat(ps.top);
      x = cb.x + (isNaN(L) ? 0 : L) + ml;
      y = cb.y + (isNaN(T) ? 0 : T) + mt;
      const tm = (ps.transform || '').match(/^matrix\(([^)]+)\)$/);
      if (tm) { const v = tm[1].split(',').map(parseFloat); x += v[4]; y += v[5]; }
    } else {
      const c = contentBox(cs, box);
      if (which === '::before') { x = c.x + ml; y = c.y + mt; }
      else if (ps.display !== 'inline') { x = c.x + ml; y = c.y + c.h - h - px(ps.marginBottom); }
      else {
        const end = lastTextRect(el);
        x = end ? end.right + ctx.offX + ml : c.x + c.w - w;
        y = end ? end.top + ctx.offY : c.y;
      }
    }
    const pbox = { x: rnd(x), y: rnd(y), w: rnd(w), h: rnd(h) };
    if (!intersects(pbox)) return null;
    const node = common({ type: 'FRAME', name: which, ...pbox, ...boxStyle(ps, pbox), children: [] }, ps);
    if (run) {
      const c = contentBox(ps, pbox);
      const lh = run.lineHeight || run.size * 1.2;
      const tbox = { x: c.x, y: c.y, w: Math.max(c.w, 1), h: rnd(lh) };
      if (ICON_FONT.test(run.font.families[0] || '') || /^[-\s]+$/.test(text)) {
        const url = rasterText(text.trim(), ps, tbox.w, tbox.h);
        if (url) node.children.push({ type: 'IMAGE', name: 'icon', ...tbox, image: regImage(url, 'node'), scale: 'FIT', fills: [] });
      } else {
        node.children.push({ type: 'TEXT', name: text.trim().slice(0, 40), ...tbox, lines: 1, align: alignOf(ps), runs: [{ text, style: styleId(run) }] });
      }
    }
    if (!node.children.length && isPlain(node)) return null;
    return node;
  }

  // ---------- list markers ----------
  const roman = n => [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
    .reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '');
  function markerNode(el, cs, box) {
    const t = cs.listStyleType;
    if (cs.display !== 'list-item' || !t || t === 'none' || cs.listStylePosition !== 'outside' || cs.listStyleImage !== 'none') return null;
    let text = { disc: '•', circle: '◦', square: '▪' }[t];
    if (!text) {
      const p = el.parentElement;
      let n = p && p.localName === 'ol' && p.hasAttribute('start') ? p.start : 1;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === 'li') n++;
      const up = t.startsWith('upper');
      text = (/alpha|latin/.test(t) ? String.fromCharCode((up ? 64 : 96) + (((n - 1) % 26) + 1)) : /roman/.test(t) ? (up ? roman(n).toUpperCase() : roman(n)) : n) + '.';
    }
    const st = runStyle(cs, el), lh = st.lineHeight || st.size * 1.2, w = st.size * 3;
    const c = contentBox(cs, box);
    const node = { type: 'TEXT', name: 'marker', x: rnd(box.x - w - st.size * 0.45), y: rnd(c.y), w: rnd(w), h: rnd(lh), lines: 1, align: 'RIGHT', runs: [{ text, style: styleId(st) }] };
    return intersects(node) ? node : null;
  }

  // ---------- inline SVG ----------
  const SVG_DEFAULTS = { fill: 'rgb(0, 0, 0)', 'fill-opacity': '1', 'fill-rule': 'nonzero', stroke: 'none', 'stroke-width': '1px', 'stroke-opacity': '1', 'stroke-linecap': 'butt',
    'stroke-linejoin': 'miter', 'stroke-dasharray': 'none', 'stroke-dashoffset': '0px', 'stroke-miterlimit': '4', opacity: '1', 'stop-color': 'rgb(0, 0, 0)', 'stop-opacity': '1',
    'text-anchor': 'start', 'clip-rule': 'nonzero', visibility: 'visible' };
  const NOT_INHERITED = new Set(['opacity', 'stop-color', 'stop-opacity']);
  const SVG_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
    'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'stop-color', 'stop-opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'clip-rule', 'visibility'];
  const localUrl = v => v.replace(/url\(\s*["']?[^"'#)]*(#[^"')]+)["']?\s*\)/g, 'url($1)');
  function serializeSvg(svg, box) {
    const doc = svg.ownerDocument;
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
    const drop = [];
    const hasText = !!svg.querySelector('text');
    src.forEach((s, i) => {
      const d = dst[i];
      const c = getCS(s);
      const inDefs = s.closest('defs, symbol, clipPath, mask, pattern, linearGradient, radialGradient, marker, filter');
      if (c.display === 'none' && i && !inDefs) { drop.push(d); return; }
      const pc = i && s.parentElement ? getCS(s.parentElement) : null;
      for (const p of SVG_PROPS) {
        const v = c.getPropertyValue(p);
        if (!v || (p.startsWith('font') && !hasText)) continue;
        const inherited = pc && !NOT_INHERITED.has(p) ? pc.getPropertyValue(p) : SVG_DEFAULTS[p];
        if (v !== inherited) d.setAttribute(p, localUrl(v));
      }
      d.removeAttribute('class');
      d.removeAttribute('style');
    });
    drop.forEach(d => d.remove());
    // Inline <use href="#id"> so Figma doesn't need the page's sprite sheet.
    for (const u of clone.querySelectorAll('use')) {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      if (!href.startsWith('#')) continue;
      const ref = doc.getElementById(href.slice(1));
      if (!ref) continue;
      const isSym = ref.localName === 'symbol' || ref.localName === 'svg';
      const g = document.createElementNS(SVG_NS, isSym ? 'svg' : 'g');
      for (const p of SVG_PROPS) if (u.hasAttribute(p)) g.setAttribute(p, u.getAttribute(p));
      const x = u.getAttribute('x') || 0, y = u.getAttribute('y') || 0;
      if (isSym) {
        g.setAttribute('x', x); g.setAttribute('y', y);
        g.setAttribute('width', u.getAttribute('width') || '100%');
        g.setAttribute('height', u.getAttribute('height') || '100%');
        if (ref.getAttribute('viewBox')) g.setAttribute('viewBox', ref.getAttribute('viewBox'));
      } else g.setAttribute('transform', `translate(${x},${y})`);
      for (const ch of ref.childNodes) g.appendChild(ch.cloneNode(true));
      const color = u.getAttribute('fill');
      if (color) g.querySelectorAll('[fill="currentColor"],[stroke="currentColor"]').forEach(e => {
        if (e.getAttribute('fill') === 'currentColor') e.setAttribute('fill', color);
        if (e.getAttribute('stroke') === 'currentColor') e.setAttribute('stroke', color);
      });
      if (u.getAttribute('transform')) {
        const wrap = document.createElementNS(SVG_NS, 'g');
        wrap.setAttribute('transform', u.getAttribute('transform'));
        wrap.appendChild(g);
        u.replaceWith(wrap);
      } else u.replaceWith(g);
    }
    // Pull in gradients/clipPaths that live in some other <svg> on the page.
    const ids = new Set();
    for (const e of clone.querySelectorAll('*')) for (const a of e.attributes) for (const m of a.value.matchAll(/url\(#([^)]+)\)|^#(.+)$/g)) ids.add(m[1] || m[2]);
    let defs = null;
    for (const id of ids) {
      if (clone.querySelector(`[id="${CSS.escape(id)}"]`)) continue;
      const ref = doc.getElementById(id);
      if (!ref) continue;
      if (!defs) { defs = document.createElementNS(SVG_NS, 'defs'); clone.prepend(defs); }
      defs.appendChild(ref.cloneNode(true));
    }
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('width', box.w);
    clone.setAttribute('height', box.h);
    if (!clone.hasAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${box.w} ${box.h}`);
    return new XMLSerializer().serializeToString(clone);
  }

  // ---------- form controls ----------
  const WHITE = { r: 1, g: 1, b: 1, a: 1 };
  function formNode(el, cs, box, style) {
    const tag = el.localName, type = (el.getAttribute('type') || '').toLowerCase();
    const node = { type: 'FRAME', name: nameOf(el), ...box, ...style, children: [] };
    if ((type === 'checkbox' || type === 'radio') && cs.appearance !== 'none') {
      const accent = shows(parseColor(cs.accentColor)) ? parseColor(cs.accentColor) : { r: 0, g: 0.46, b: 1, a: 1 };
      node.fills = [{ type: 'SOLID', color: el.checked ? accent : WHITE }];
      node.stroke = { color: el.checked ? accent : { r: 0.46, g: 0.46, b: 0.46, a: 1 }, weights: [1, 1, 1, 1], style: 'solid' };
      const r = type === 'radio' ? box.w / 2 : 2;
      node.radius = [r, r, r, r];
      if (el.checked && type === 'radio') {
        node.fills = [{ type: 'SOLID', color: WHITE }];
        const d = box.w * 0.5;
        node.children.push({ type: 'FRAME', name: 'dot', x: box.x + (box.w - d) / 2, y: box.y + (box.h - d) / 2, w: d, h: d, radius: [d / 2, d / 2, d / 2, d / 2], fills: [{ type: 'SOLID', color: accent }], children: [] });
      } else if (el.checked) {
        node.children.push({ type: 'SVG', name: 'check', ...box, svg: `<svg xmlns="${SVG_NS}" width="${box.w}" height="${box.h}" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` });
      }
      return node;
    }
    let text = '', placeholder = false;
    const isButton = ['submit', 'button', 'reset'].includes(type);
    if (tag === 'select') text = (el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].text) || '';
    else if (isButton) text = el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    else if (tag === 'textarea' || ['', 'text', 'email', 'search', 'password', 'number', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type)) {
      text = el.value || '';
      if (type === 'password') text = '•'.repeat(text.length);
      if (!text && el.placeholder) { text = el.placeholder; placeholder = true; }
    }
    if (text) {
      const st = runStyle(placeholder ? getCS(el, '::placeholder') : cs, el);
      const c = contentBox(cs, box);
      const lh = st.lineHeight || st.size * 1.2;
      const multi = tag === 'textarea';
      node.children.push({
        type: 'TEXT', name: text.slice(0, 40), x: c.x, y: rnd(multi ? c.y : c.y + (c.h - lh) / 2), w: c.w, h: rnd(lh),
        lines: multi ? 2 : 1, align: isButton ? 'CENTER' : alignOf(cs), runs: [{ text, style: styleId(st) }],
      });
    }
    if (tag === 'select' && cs.appearance !== 'none') {
      const st = runStyle(cs, el), c = contentBox(cs, box);
      node.children.push({ type: 'TEXT', name: 'caret', x: c.x + c.w - st.size, y: c.y + (c.h - st.size * 1.2) / 2, w: st.size, h: st.size * 1.2, lines: 1, align: 'RIGHT', runs: [{ text: '▾', style: styleId(st) }] });
    }
    return node;
  }

  // ---------- tree walk ----------
  function nameOf(el) {
    if (el.localName === 'h2f-pseudo') return el.dataset.name;
    const label = el.getAttribute('aria-label') || (el.localName === 'img' && el.getAttribute('alt'));
    if (label) return label.trim().slice(0, 40);
    let n = el.localName;
    if (el.id) n += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) n += '.' + el.className.trim().split(/\s+/)[0];
    return n;
  }
  function intersects(b) {
    return !bounds || (b.x < bounds.x + bounds.w && b.x + b.w > bounds.x && b.y < bounds.y + bounds.h && b.y + b.h > bounds.y);
  }
  function isPlain(n) {
    return !n.fills.length && !n.stroke && !n.effects && !n.opacity && !n.blend;
  }
  function overflows(n) {
    return n.children.some(c => c.x < n.x - 0.5 || c.y < n.y - 0.5 || c.x + c.w > n.x + n.w + 0.5 || c.y + c.h > n.y + n.h + 0.5);
  }

  function walkChildren(el, cs, ctx) {
    const out = [];
    const childCtx = { ...ctx, keep: /flex|grid/.test(cs.display) };
    for (const ch of kids(el)) {
      if (ch.nodeType === 3) {
        if (!ch.data.trim() || cs.visibility !== 'visible') continue;
        const t = textNode(normalizeRuns([{ text: ch.data, mode: collapseMode(cs), el, cs }]), ch, cs, el, ctx);
        if (t) out.push(common(t, { opacity: '1', position: 'static' }));
      } else if (ch.nodeType === 1) {
        const r = walk(ch, childCtx);
        if (Array.isArray(r)) out.push(...r);
        else if (r) out.push(r);
      }
    }
    return out;
  }

  function walk(el, ctx) {
    const tag = el.localName;
    if (SKIP.has(tag) || el.hasAttribute(UI_ATTR)) return null;
    if (++state.count > opts.maxNodes) { state.truncated = true; return null; }
    const cs = getCS(el);
    if (cs.display === 'none' || cs.contentVisibility === 'hidden') return null;
    if (parseFloat(cs.opacity) === 0) return null;
    if (cs.display === 'contents') return walkChildren(el, cs, ctx);
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1 && /hidden|clip/.test(cs.overflow)) return null; // screen-reader-only
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(cs.clipPath)) return null;
    const box = { x: rnd(r.left + ctx.offX), y: rnd(r.top + ctx.offY), w: rnd(r.width), h: rnd(r.height) };
    const inView = intersects(box);
    const visible = cs.visibility === 'visible' && inView;
    const style = visible ? boxStyle(cs, box) : { fills: [] };
    const name = nameOf(el);
    let node = null;

    if (tag === 'img') {
      const src = el.currentSrc || el.src;
      if (!visible) return null;
      if (src && el.complete && el.naturalWidth) node = { type: 'IMAGE', name, ...box, ...style, image: regImage(src, 'node'), scale: fitScale(cs.objectFit) };
      else node = { type: 'FRAME', name: name + ' (not loaded)', ...box, ...style, fills: style.fills.length ? style.fills : [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.92, a: 1 } }], children: [] };
    } else if (tag === 'svg') {
      if (!visible || box.w <= 0 || box.h <= 0) return null;
      node = { type: 'SVG', name, ...box, svg: serializeSvg(el, box) };
      if (style.effects) node.effects = style.effects;
    } else if (tag === 'canvas' || tag === 'video') {
      if (!visible) return null;
      let url = null;
      try {
        if (tag === 'canvas') url = el.toDataURL('image/png');
        else if (el.videoWidth) {
          const c = document.createElement('canvas');
          c.width = el.videoWidth; c.height = el.videoHeight;
          c.getContext('2d').drawImage(el, 0, 0);
          url = c.toDataURL('image/jpeg', 0.85);
        }
      } catch { /* cross-origin pixels */ }
      if ((!url || url.length < 30) && tag === 'video' && el.poster) url = el.poster;
      node = url && url.length > 30
        ? { type: 'IMAGE', name, ...box, ...style, image: regImage(url, 'node'), scale: tag === 'video' ? fitScale(cs.objectFit || 'contain') : 'STRETCH' }
        : { type: 'FRAME', name: name + ' (unavailable)', ...box, ...style, fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }], children: [] };
    } else if (tag === 'iframe') {
      let doc = null;
      try { doc = el.contentDocument; } catch { /* cross-origin */ }
      node = { type: 'FRAME', name, ...box, ...style, clip: true, children: [] };
      if (doc && doc.body) {
        const c = contentBox(cs, box);
        const icx = { win: el.contentWindow, offX: c.x, offY: c.y, keep: false };
        const bcs = getCS(doc.body);
        const dcs = getCS(doc.documentElement);
        node.fills.push(...boxStyle(shows(parseColor(dcs.backgroundColor)) ? dcs : bcs, box).fills);
        node.children = walkChildren(doc.body, bcs, icx);
      } else if (visible) {
        node.name = name + ' (cross-origin)';
        if (!node.fills.length) node.fills = [{ type: 'SOLID', color: { r: 0.95, g: 0.95, b: 0.96, a: 1 } }];
      }
    } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (!visible) return null;
      node = formNode(el, cs, box, style);
    } else if (tag === 'object' || tag === 'embed' || tag === 'audio') {
      if (!visible) return null;
      node = { type: 'FRAME', name, ...box, ...style, children: [] };
    } else {
      node = { type: 'FRAME', name, ...box, ...style, children: [] };
      if (visible && !NO_PSEUDO.has(tag)) { const b = pseudoNode(el, cs, '::before', box, ctx); if (b) node.children.push(b); }
      if (visible) { const m = markerNode(el, cs, box); if (m) node.children.push(m); }
      if (cs.visibility === 'visible' && isTextBlock(el, cs)) {
        const t = textBlock(el, cs, ctx);
        if (t) node.children.push(common(t, { opacity: '1', position: 'static' }));
      } else node.children.push(...walkChildren(el, cs, ctx));
      if (visible && !NO_PSEUDO.has(tag)) { const a = pseudoNode(el, cs, '::after', box, ctx); if (a) node.children.push(a); }
    }

    common(node, cs);
    if (node.type !== 'FRAME') return node;

    detectLayout(node, cs);
    if (!node.layout) node.children.sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const c of node.children) delete c.z;
    if (node.clip && !overflows(node)) delete node.clip;

    if (isPlain(node) && !node.clip && !node.layout && !REPLACED.has(tag)) {
      if (!node.children.length) return null;
      if (opts.simplify && !ctx.keep && node.children.length === 1) {
        const only = node.children[0];
        if (node.z) only.z = node.z;
        if (node.abs) only.abs = 1;
        return only;
      }
    }
    return node;
  }

  // ---------- flexbox → Auto Layout ----------
  const JUSTIFY = { normal: 'MIN', 'flex-start': 'MIN', start: 'MIN', left: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', right: 'MAX', 'space-between': 'SPACE_BETWEEN' };
  const ALIGN = { normal: 'STRETCH', stretch: 'STRETCH', 'flex-start': 'MIN', start: 'MIN', 'self-start': 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', 'self-end': 'MAX', baseline: 'BASELINE' };
  function detectLayout(node, cs) {
    if (!opts.autoLayout || !/^(inline-)?flex$/.test(cs.display) || cs.flexWrap !== 'nowrap') return;
    const row = cs.flexDirection === 'row';
    if (!row && cs.flexDirection !== 'column') return;
    const justify = JUSTIFY[cs.justifyContent], align = ALIGN[cs.alignItems];
    if (!justify || !align || (align === 'BASELINE' && !row)) return;
    const flow = node.children.filter(c => !c.abs);
    if (!flow.length) return;
    const pad = ['Top', 'Right', 'Bottom', 'Left'].map(s => rnd(px(cs[`padding${s}`]) + px(cs[`border${s}Width`])));
    const pos = c => (row ? c.x : c.y), size = c => (row ? c.w : c.h);
    const gaps = [];
    for (let i = 1; i < flow.length; i++) gaps.push(pos(flow[i]) - pos(flow[i - 1]) - size(flow[i - 1]));
    if (gaps.some(g => g < -0.5)) return; // reordered or overlapping items
    const gap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    if (justify !== 'SPACE_BETWEEN' && gaps.some(g => Math.abs(g - gap) > 1)) return; // margins vary: can't express as one spacing
    if (justify === 'MIN' && Math.abs(pos(flow[0]) - (row ? node.x + pad[3] : node.y + pad[0])) > 1) return;
    const inner = row ? node.h - pad[0] - pad[2] : node.w - pad[1] - pad[3];
    if (align === 'STRETCH') for (const c of flow) if (Math.abs((row ? c.h : c.w) - inner) <= 1) c.stretch = 1;
    node.layout = { dir: row ? 'HORIZONTAL' : 'VERTICAL', gap: rnd(Math.max(0, gap)), pad, justify, align };
  }

  // ---------- page prep ----------
  async function loadLazy() {
    document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
    const step = innerHeight * 0.8;
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 100; y += step, i++) {
      scrollTo(0, y);
      await sleep(100);
    }
    scrollTo(0, 0);
    await sleep(400);
  }
  async function waitForImages() {
    const pending = [...document.images].filter(i => !i.complete);
    await Promise.race([Promise.all(pending.map(i => new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), sleep(4000)]);
  }

  function pick() {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.setAttribute(UI_ATTR, '');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #0d99ff;background:rgba(13,153,255,.12);border-radius:2px;box-sizing:border-box;';
      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;left:-2px;bottom:100%;margin-bottom:4px;background:#0d99ff;color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:3px;white-space:nowrap;';
      box.append(label);
      document.documentElement.append(box);
      let cur = null;
      const show = el => {
        cur = el;
        const r = el.getBoundingClientRect();
        Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        label.textContent = `${nameOf(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
      };
      const block = e => { e.preventDefault(); e.stopPropagation(); };
      const move = e => { const el = document.elementFromPoint(e.clientX, e.clientY); if (el && !el.closest(`[${UI_ATTR}]`)) show(el); };
      const click = e => { block(e); if (cur) done(cur); };
      const key = e => {
        if (e.key === 'Escape') { block(e); done(null); }
        else if (e.key === 'ArrowUp' && cur && cur.parentElement && cur.parentElement !== document.documentElement) { block(e); show(cur.parentElement); }
        else if (e.key === 'Enter' && cur) { block(e); done(cur); }
      };
      const evs = [['mousemove', move], ['click', click], ['keydown', key], ['mousedown', block], ['mouseup', block], ['pointerdown', block], ['pointerup', block]];
      const done = el => { evs.forEach(([t, f]) => removeEventListener(t, f, true)); box.remove(); resolve(el); };
      evs.forEach(([t, f]) => addEventListener(t, f, true));
    });
  }

  function decodeDataText(url) {
    const i = url.indexOf(',');
    const meta = url.slice(5, i), body = url.slice(i + 1);
    if (!meta.includes('base64')) return decodeURIComponent(body);
    return new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0)));
  }
  // data: and blob: URLs only make sense inside this page, so resolve them here.
  async function resolveLocalImages() {
    await Promise.all(Object.values(state.images).map(async im => {
      try {
        if (im.url.startsWith('data:image/svg+xml')) im.svg = decodeDataText(im.url);
        else if (im.url.startsWith('data:')) im.data = im.url;
        else if (im.url.startsWith('blob:')) {
          const b = await (await fetch(im.url)).blob();
          if (b.type.includes('svg')) im.svg = await b.text();
          else im.data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });
        } else return;
        im.url = im.url.slice(0, 40);
      } catch (e) { im.error = String(e.message || e); }
    }));
  }

  async function capture(o) {
    opts = { mode: 'full', autoLayout: false, simplify: true, lazyLoad: true, maxNodes: 30000, ...o };
    state = { count: 0, images: {}, urlIds: new Map(), styles: [], styleIds: new Map(), truncated: false };
    let target = null;
    if (opts.mode === 'pick') {
      target = await pick();
      if (!target) return { cancelled: true };
    }
    if (opts.mode === 'full' && opts.lazyLoad) await loadLazy();
    else if (opts.mode === 'full') scrollTo(0, 0);
    if (document.fonts) await document.fonts.ready;
    await waitForImages();

    const de = document.documentElement, body = document.body;
    let root;
    if (target) {
      const r = target.getBoundingClientRect();
      bounds = null;
      const ctx = { win: window, offX: -r.left, offY: -r.top, keep: true };
      let n = walk(target, ctx);
      if (Array.isArray(n)) n = { type: 'FRAME', name: nameOf(target), x: 0, y: 0, w: rnd(r.width), h: rnd(r.height), fills: [], children: n };
      if (!n) throw new Error('Nothing visible inside the selected element.');
      if (n.type !== 'FRAME') n = { type: 'FRAME', name: nameOf(target), x: 0, y: 0, w: n.w, h: n.h, fills: [], children: [{ ...n, x: 0, y: 0 }] };
      delete n.abs;
      delete n.z;
      root = n;
    } else {
      const full = opts.mode === 'full';
      const w = de.clientWidth, h = full ? Math.max(de.scrollHeight, body.scrollHeight) : innerHeight;
      bounds = full ? null : { x: 0, y: 0, w, h };
      const ctx = { win: window, offX: full ? scrollX : 0, offY: full ? scrollY : 0, keep: false };
      const bodyCs = getCS(body), htmlCs = getCS(de);
      const canvasCs = shows(parseColor(htmlCs.backgroundColor)) || htmlCs.backgroundImage !== 'none' ? htmlCs : bodyCs;
      const children = walkChildren(body, bodyCs, ctx);
      children.sort((a, b) => (a.z || 0) - (b.z || 0)).forEach(c => delete c.z);
      root = {
        type: 'FRAME', name: document.title || location.hostname, x: 0, y: 0, w, h, clip: true,
        fills: [{ type: 'SOLID', color: WHITE }, ...boxStyle(canvasCs, { x: 0, y: 0, w, h }).fills],
        children,
      };
    }
    await resolveLocalImages();
    return {
      format: 'html-to-figma',
      version: 1,
      source: { url: location.href, title: document.title, mode: opts.mode, width: root.w, height: root.h, capturedAt: new Date().toISOString() },
      root,
      styles: state.styles,
      images: state.images,
      stats: { elements: state.count, truncated: state.truncated },
    };
  }

  window.__h2f = { capture, _test: { parseColor, parseGradient, parseShadows, splitTop, pseudoText, normalizeRuns } };
})();
