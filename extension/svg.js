// Turns a capture into one SVG document. Figma's canvas pastes SVG code as editable vectors, text and masks,
// which is what lets "copy in the browser, Ctrl+V in Figma" work without the plugin.
var toFigmaSvg = (() => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const n2 = v => Math.round((v || 0) * 100) / 100;
  const rgb = c => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  const alpha = (attr, a) => (a < 1 ? ` ${attr}="${n2(a)}"` : '');
  const b64utf8 = s => btoa(unescape(encodeURIComponent(s)));
  const GENERIC = /^(system-ui|-apple-system|blinkmacsystemfont|ui-sans-serif|ui-serif|ui-monospace|ui-rounded)$/i;
  const PAR = { FILL: 'xMidYMid slice', TILE: 'xMidYMid slice', FIT: 'xMidYMid meet', STRETCH: 'none', CROP: 'none' };

  return function toFigmaSvg(p) {
    let uid = 0;
    const defs = [];
    const names = new Map();
    const nextId = prefix => `${prefix}${++uid}`;

    // Figma names imported layers after the SVG id, so keep ids readable and unique.
    function layerId(name) {
      let base = String(name || 'layer').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'layer';
      if (!/^[A-Za-z_]/.test(base)) base = 'n-' + base;
      const n = (names.get(base) || 0) + 1;
      names.set(base, n);
      return n > 1 ? `${base}-${n}` : base;
    }

    function shape(b, radius, attrs) {
      const r = radius || [0, 0, 0, 0];
      const w = Math.max(0, b.w), h = Math.max(0, b.h);
      if (r.every(v => v === r[0])) return `<rect x="${n2(b.x)}" y="${n2(b.y)}" width="${n2(w)}" height="${n2(h)}"${r[0] ? ` rx="${n2(r[0])}"` : ''}${attrs}/>`;
      const [tl, tr, br, bl] = r.map(n2), x = n2(b.x), y = n2(b.y), X = n2(b.x + w), Y = n2(b.y + h);
      const d = `M${n2(x + tl)},${y}H${n2(X - tr)}A${tr},${tr} 0 0 1 ${X},${n2(y + tr)}V${n2(Y - br)}A${br},${br} 0 0 1 ${n2(X - br)},${Y}` +
        `H${n2(x + bl)}A${bl},${bl} 0 0 1 ${x},${n2(Y - bl)}V${n2(y + tl)}A${tl},${tl} 0 0 1 ${n2(x + tl)},${y}Z`;
      return `<path d="${d}"${attrs}/>`;
    }

    function clipTo(b, radius, inner) {
      const id = nextId('clip');
      defs.push(`<clipPath id="${id}">${shape(b, radius, '')}</clipPath>`);
      return `<g clip-path="url(#${id})">${inner}</g>`;
    }

    function paint(f, b) {
      if (f.type === 'SOLID') return ` fill="${rgb(f.color)}"${alpha('fill-opacity', f.color.a)}`;
      if (!f.stops || !f.stops.length) return null;
      const id = nextId('grad');
      const stops = f.stops.map(s => `<stop offset="${n2(s.pos)}" stop-color="${rgb(s.color)}"${alpha('stop-opacity', s.color.a)}/>`).join('');
      if (f.type === 'RADIAL') defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`);
      else {
        const a = ((f.angle === undefined ? 180 : f.angle) * Math.PI) / 180;
        const dx = Math.sin(a), dy = -Math.cos(a), L = Math.abs(b.w * dx) + Math.abs(b.h * dy), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n2(cx - (dx * L) / 2)}" y1="${n2(cy - (dy * L) / 2)}" x2="${n2(cx + (dx * L) / 2)}" y2="${n2(cy + (dy * L) / 2)}">${stops}</linearGradient>`);
      }
      return ` fill="url(#${id})"`;
    }

    // Drop shadows in the same filter shape Figma exports, so it reads them back as shadow effects.
    function shadowFilter(effects, b) {
      const list = (effects || []).filter(e => e.type === 'SHADOW' && !e.inset);
      if (!list.length) return '';
      const id = nextId('shadow');
      let pad = 0;
      for (const e of list) pad = Math.max(pad, e.blur * 1.5 + Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.spread || 0));
      let body = '<feFlood flood-opacity="0" result="BackgroundImageFix"/>', prev = 'BackgroundImageFix';
      list.forEach((e, i) => {
        body += '<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>';
        if (e.spread) body += `<feMorphology radius="${n2(Math.abs(e.spread))}" operator="${e.spread > 0 ? 'dilate' : 'erode'}" in="SourceAlpha"/>`;
        body += `<feOffset dx="${n2(e.x)}" dy="${n2(e.y)}"/><feGaussianBlur stdDeviation="${n2(e.blur / 2)}"/>`;
        body += `<feColorMatrix type="matrix" values="0 0 0 0 ${n2(e.color.r)} 0 0 0 0 ${n2(e.color.g)} 0 0 0 0 ${n2(e.color.b)} 0 0 0 ${n2(e.color.a)} 0"/>`;
        body += `<feBlend mode="normal" in2="${prev}" result="effect${i + 1}_dropShadow"/>`;
        prev = `effect${i + 1}_dropShadow`;
      });
      body += `<feBlend mode="normal" in="SourceGraphic" in2="${prev}" result="shape"/>`;
      defs.push(`<filter id="${id}" x="${n2(b.x - pad)}" y="${n2(b.y - pad)}" width="${n2(b.w + pad * 2)}" height="${n2(b.h + pad * 2)}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${body}</filter>`);
      return ` filter="url(#${id})"`;
    }

    function imageHref(id) {
      const im = p.images && p.images[id];
      if (!im) return null;
      if (im.data) return im.data;
      if (im.svg) return 'data:image/svg+xml;base64,' + b64utf8(im.svg);
      return null;
    }

    function image(id, scale, b, radius) {
      const href = imageHref(id);
      if (!href) return shape(b, radius, ' fill="rgb(229,229,235)"');
      const el = `<image x="${n2(b.x)}" y="${n2(b.y)}" width="${n2(b.w)}" height="${n2(b.h)}" preserveAspectRatio="${PAR[scale] || 'xMidYMid slice'}" xlink:href="${esc(href)}"/>`;
      return (radius && radius.some(Boolean)) || scale === 'FILL' || scale === 'TILE' ? clipTo(b, radius, el) : el;
    }

    // Embed an SVG icon in place, with its ids prefixed so two icons can't clash.
    function nestSvg(markup, b) {
      const pre = `s${++uid}_`;
      let s = markup.replace(/<\?xml[^>]*>/, '').replace(/<!DOCTYPE[^>]*>/i, '').trim();
      s = s.replace(/\bid=(["'])([^"']+)\1/g, (_, q, id) => `id=${q}${pre}${id}${q}`)
        .replace(/url\(\s*['"]?#([^'")]+)['"]?\s*\)/g, (_, id) => `url(#${pre}${id})`)
        .replace(/((?:xlink:)?href)=(["'])#([^"']+)\2/g, (_, a, q, id) => `${a}=${q}#${pre}${id}${q}`);
      return s.replace(/<svg\b([^>]*)>/, (_, attrs) => {
        const wm = attrs.match(/\swidth=["']([\d.]+)/), hm = attrs.match(/\sheight=["']([\d.]+)/);
        let a = attrs.replace(/\s(width|height|x|y)=(["'])[^"']*\2/g, '');
        if (!/viewBox=/.test(a) && wm && hm) a += ` viewBox="0 0 ${wm[1]} ${hm[1]}"`;
        return `<svg${a} x="${n2(b.x)}" y="${n2(b.y)}" width="${n2(b.w)}" height="${n2(b.h)}">`;
      });
    }

    function border(n) {
      const s = n.stroke;
      if (!s) return '';
      const [t, r, bt, l] = s.weights, c = ` fill="${rgb(s.color)}"${alpha('fill-opacity', s.color.a)}`;
      if (t === r && r === bt && bt === l) {
        const w = t, inner = { x: n.x + w / 2, y: n.y + w / 2, w: n.w - w, h: n.h - w };
        const rad = n.radius && n.radius.map(v => Math.max(0, v - w / 2));
        const dash = s.style === 'dashed' ? ` stroke-dasharray="${n2(w * 3)} ${n2(w * 2)}"` : s.style === 'dotted' ? ` stroke-dasharray="${n2(w)} ${n2(w)}"` : '';
        return shape(inner, rad, ` fill="none" stroke="${rgb(s.color)}"${alpha('stroke-opacity', s.color.a)} stroke-width="${n2(w)}"${dash}`);
      }
      // Different widths per side: draw each side as a bar, clipped to the rounded box.
      const bars = [
        t && shape({ x: n.x, y: n.y, w: n.w, h: t }, null, c),
        r && shape({ x: n.x + n.w - r, y: n.y, w: r, h: n.h }, null, c),
        bt && shape({ x: n.x, y: n.y + n.h - bt, w: n.w, h: bt }, null, c),
        l && shape({ x: n.x, y: n.y, w: l, h: n.h }, null, c),
      ].filter(Boolean).join('');
      return n.radius && n.radius.some(Boolean) ? clipTo(n, n.radius, bars) : bars;
    }

    function frame(n) {
      let parts = '';
      const filter = shadowFilter(n.effects, n);
      let shadowUsed = false;
      for (const f of n.fills || []) {
        if (f.type === 'IMAGE') { parts += image(f.image, f.scale, n, n.radius); continue; }
        const a = paint(f, n);
        if (!a) continue;
        parts += shape(n, n.radius, a + (shadowUsed ? '' : filter));
        shadowUsed = true;
      }
      parts += border(n);
      let inner = (n.children || []).map(node).join('');
      if (n.clip && inner) inner = clipTo(n, n.radius, inner);
      return `<g id="${esc(layerId(n.name))}"${n.opacity !== undefined ? ` opacity="${n2(n.opacity)}"` : ''}>${parts}${inner}</g>`;
    }

    const applyCase = (t, c) => (c === 'UPPER' ? t.toUpperCase() : c === 'LOWER' ? t.toLowerCase() : c === 'TITLE' ? t.replace(/\b\p{L}/gu, m => m.toUpperCase()) : t);
    function fontAttrs(st, base) {
      const fam = st.font.families.filter(f => !GENERIC.test(f)).map(f => (/^[\w-]+$/.test(f) ? f : `'${f.replace(/'/g, '')}'`)).join(', ') || 'Inter, sans-serif';
      const all = {
        'font-family': fam, 'font-size': n2(st.size), 'font-weight': st.font.weight, 'font-style': st.font.italic ? 'italic' : 'normal',
        fill: st.color ? rgb(st.color) : 'rgb(0,0,0)', 'fill-opacity': st.color && st.color.a < 1 ? n2(st.color.a) : 1,
        'letter-spacing': n2(st.letterSpacing), 'text-decoration': { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }[st.decoration] || 'none',
      };
      return Object.entries(all).filter(([k, v]) => !base || base[k] !== v).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    }
    function fontMap(st) {
      const m = {};
      fontAttrs(st).replace(/ ([\w-]+)="([^"]*)"/g, (_, k, v) => { m[k] = v.replace(/&quot;/g, '"').replace(/&amp;/g, '&'); });
      return m;
    }

    // Splits runs into lines at the browser's wrap points (or a rough estimate when those weren't recorded).
    function textLines(n) {
      const breaks = new Set(n.breaks || []);
      const lines = [[]];
      let pos = 0;
      for (const r of n.runs) {
        const st = p.styles[r.style];
        let buf = '';
        const flush = () => { if (buf) lines[lines.length - 1].push({ text: buf, st }); buf = ''; };
        for (const ch of r.text) {
          if (ch === '\n' || breaks.has(pos)) { flush(); lines.push([]); }
          if (ch !== '\n') buf += ch;
          pos += ch.length;
        }
        flush();
      }
      for (const line of lines) {
        const last = line[line.length - 1];
        if (last) last.text = last.text.replace(/\s+$/, '');
      }
      if (n.lines > 1 && lines.length === 1 && !n.breaks && n.w > 0) {
        // No recorded wrap points: wrap greedily using an average character width.
        const out = [[]];
        let width = 0;
        for (const seg of lines[0]) for (const word of seg.text.split(/(?<=\s)/)) {
          const ww = word.length * seg.st.size * 0.52;
          if (width + ww > n.w + 1 && width > 0) { out.push([]); width = 0; }
          out[out.length - 1].push({ text: word, st: seg.st });
          width += ww;
        }
        return out.map(l => { const last = l[l.length - 1]; if (last) last.text = last.text.replace(/\s+$/, ''); return l; });
      }
      return lines;
    }

    function text(n) {
      if (!n.runs || !n.runs.length) return '';
      const st0 = p.styles[n.runs[0].style];
      const asc = st0.asc || st0.size * 0.8, desc = st0.desc || st0.size * 0.2;
      const lh = st0.lineHeight || asc + desc;
      const baseline = n.y + (lh - (asc + desc)) / 2 + asc;
      const anchor = { CENTER: 'middle', RIGHT: 'end' }[n.align] || 'start';
      const x = anchor === 'middle' ? n.x + n.w / 2 : anchor === 'end' ? n.x + n.w : n.x;
      const base = fontMap(st0);
      const body = textLines(n).map((line, i) => {
        if (!line.length) return '';
        const segs = line.map(s => {
          const t = esc(applyCase(s.text, s.st.textCase));
          const diff = s.st === st0 ? '' : fontAttrs(s.st, base);
          return diff ? `<tspan${diff}>${t}</tspan>` : t;
        }).join('');
        return `<tspan x="${n2(x)}" y="${n2(baseline + i * lh)}">${segs}</tspan>`;
      }).join('');
      return `<text id="${esc(layerId(n.name))}" xml:space="preserve" text-anchor="${anchor}"${fontAttrs(st0)}${n.opacity !== undefined ? ` opacity="${n2(n.opacity)}"` : ''}>${body}</text>`;
    }

    function node(n) {
      if (n.type === 'TEXT') return text(n);
      if (n.type === 'SVG') return n.svg ? nestSvg(n.svg, n) : '';
      if (n.type === 'IMAGE') {
        const im = p.images && p.images[n.image];
        const bg = (n.fills || []).map(f => { const a = f.type !== 'IMAGE' && paint(f, n); return a ? shape(n, n.radius, a) : ''; }).join('');
        const content = im && im.svg && im.node ? nestSvg(im.svg, n) : image(n.image, n.scale, n, n.radius);
        return `<g id="${esc(layerId(n.name))}"${n.opacity !== undefined ? ` opacity="${n2(n.opacity)}"` : ''}>${bg}${content}${border(n)}</g>`;
      }
      return frame(n);
    }

    const root = p.root, body = frame({ ...root, x: 0, y: 0 });
    const w = n2(root.w), h = n2(root.h);
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs>${defs.join('')}</defs>${body}</svg>`;
  };
})();
if (typeof module !== 'undefined') module.exports = toFigmaSvg;
