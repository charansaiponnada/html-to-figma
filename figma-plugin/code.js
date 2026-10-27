// Rebuilds a page captured by the HTML to Figma Chrome extension as native, editable Figma layers.

// ---------- fonts ----------
const WEIGHTS = [['thin', 100], ['hairline', 100], ['extralight', 200], ['ultralight', 200], ['light', 300], ['regular', 400], ['normal', 400], ['book', 400],
  ['roman', 400], ['medium', 500], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800], ['bold', 700], ['extrablack', 950], ['black', 900], ['heavy', 900]];
const SANS = ['Inter', 'Roboto', 'Arial', 'Helvetica'];
const SERIF = ['Times New Roman', 'Georgia', 'Noto Serif', 'Roboto Serif', 'Source Serif Pro', 'Merriweather'];
const MONO = ['Roboto Mono', 'Source Code Pro', 'JetBrains Mono', 'Fira Code', 'Courier New', 'Menlo'];
const GENERIC = {
  'sans-serif': SANS, 'system-ui': SANS, '-apple-system': SANS, blinkmacsystemfont: SANS, 'ui-sans-serif': SANS, 'ui-rounded': SANS,
  serif: SERIF, 'ui-serif': SERIF, monospace: MONO, 'ui-monospace': MONO, cursive: ['Comic Sans MS', 'Caveat', ...SANS], fantasy: SANS,
};

function styleWeight(style) {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  for (const [k, w] of WEIGHTS) if (s.includes(k)) return w;
  return 400;
}

function pickStyle(styles, weight, italic) {
  let best = styles[0], bestScore = Infinity;
  for (const s of styles) {
    const score = Math.abs(styleWeight(s) - weight) + (/italic|oblique/i.test(s) !== italic ? 1000 : 0) +
      (/condensed|narrow|expanded|wide|display|caption|text|small|mono/i.test(s) ? 50 : 0);
    if (score < bestScore) { best = s; bestScore = score; }
  }
  return best;
}

function makeFontResolver(available) {
  const fams = new Map();
  for (const { fontName } of available) {
    const k = fontName.family.toLowerCase();
    if (!fams.has(k)) fams.set(k, { family: fontName.family, styles: [] });
    fams.get(k).styles.push(fontName.style);
  }
  const cache = new Map(), missing = new Set();
  function resolve(font) {
    const key = font.families.join(',') + '|' + font.weight + '|' + font.italic;
    if (cache.has(key)) return cache.get(key);
    let fam = null;
    for (const f of font.families) {
      fam = (GENERIC[f.toLowerCase()] || [f]).map(c => fams.get(c.toLowerCase())).find(Boolean);
      if (fam) break;
    }
    fam = fam || fams.get('inter') || fams.values().next().value;
    const wanted = font.families.find(f => !GENERIC[f.toLowerCase()]);
    if (wanted && wanted.toLowerCase() !== fam.family.toLowerCase()) missing.add(wanted);
    const res = { family: fam.family, style: pickStyle(fam.styles, font.weight, font.italic) };
    cache.set(key, res);
    return res;
  }
  resolve.missing = missing;
  return resolve;
}

// ---------- paints & effects ----------
const rgb = c => ({ r: c.r, g: c.g, b: c.b });
const clamp01 = v => Math.min(1, Math.max(0, v || 0));
const GRADIENT = { LINEAR: 'GRADIENT_LINEAR', RADIAL: 'GRADIENT_RADIAL', ANGULAR: 'GRADIENT_ANGULAR' };
const IDENTITY = [[1, 0, 0], [0, 1, 0]];

// CSS angle (0deg = up, clockwise) → Figma gradientTransform for a w×h node.
function linearTransform(angle, w, h) {
  w = w || 1; h = h || 1;
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const p0 = { x: (w / 2 - (dx * len) / 2) / w, y: (h / 2 - (dy * len) / 2) / h };
  const d = { x: (dx * len) / w, y: (dy * len) / h };
  // Perpendicular in pixel space, so colour bands stay at right angles on non-square boxes.
  const n = { x: (-d.y * h) / w, y: (d.x * w) / h };
  // T maps gradient space (u along the line, v across it) into the node's 0..1 box; Figma wants T⁻¹.
  const T = [[d.x, n.x, p0.x - 0.5 * n.x], [d.y, n.y, p0.y - 0.5 * n.y]];
  return invert(T);
}

function invert([[a, b, c], [d, e, f]]) {
  const det = a * e - b * d || 1e-9;
  return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]];
}

function imagePaint(hash, scale) {
  if (scale === 'STRETCH') return { type: 'IMAGE', imageHash: hash, scaleMode: 'CROP', imageTransform: IDENTITY };
  return { type: 'IMAGE', imageHash: hash, scaleMode: scale || 'FILL' };
}

function toPaints(fills, w, h, hashes) {
  const out = [];
  for (const f of fills || []) {
    if (f.type === 'SOLID') out.push({ type: 'SOLID', color: rgb(f.color), opacity: clamp01(f.color.a) });
    else if (f.type === 'IMAGE') { if (hashes[f.image]) out.push(imagePaint(hashes[f.image], f.scale)); }
    else if (GRADIENT[f.type] && f.stops && f.stops.length) {
      const stops = f.stops.map(s => ({ position: clamp01(s.pos), color: { ...rgb(s.color), a: clamp01(s.color.a) } }));
      if (stops.length === 1) stops.push({ ...stops[0], position: 1 });
      out.push({ type: GRADIENT[f.type], gradientTransform: f.type === 'LINEAR' ? linearTransform(f.angle, w, h) : IDENTITY, gradientStops: stops });
    }
  }
  return out;
}

function toEffects(effects, allowSpread) {
  return (effects || []).map(e => (e.type === 'SHADOW'
    ? { type: e.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: { ...rgb(e.color), a: clamp01(e.color.a) }, offset: { x: e.x, y: e.y }, radius: Math.max(0, e.blur), spread: allowSpread ? e.spread || 0 : 0, visible: true, blendMode: 'NORMAL' }
    : { type: e.type, radius: Math.max(0, e.radius), visible: true }));
}

// ---------- node builders ----------
const PLACEHOLDER = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.92 } }];

function applyBox(node, n, ctx) {
  if (n.stroke && 'strokes' in node) {
    const [t, r, b, l] = n.stroke.weights;
    node.strokes = [{ type: 'SOLID', color: rgb(n.stroke.color), opacity: clamp01(n.stroke.color.a) }];
    node.strokeAlign = 'INSIDE';
    if (t === r && r === b && b === l) node.strokeWeight = t;
    else if ('strokeTopWeight' in node) Object.assign(node, { strokeTopWeight: t, strokeRightWeight: r, strokeBottomWeight: b, strokeLeftWeight: l });
    else node.strokeWeight = Math.max(t, r, b, l);
    const m = Math.max(t, r, b, l);
    if (n.stroke.style === 'dashed') node.dashPattern = [m * 3, m * 2];
    else if (n.stroke.style === 'dotted') node.dashPattern = [m, m];
  }
  if (n.radius && 'topLeftRadius' in node) {
    const [tl, tr, br, bl] = n.radius;
    if (tl === tr && tr === br && br === bl) node.cornerRadius = tl;
    else Object.assign(node, { topLeftRadius: tl, topRightRadius: tr, bottomRightRadius: br, bottomLeftRadius: bl });
  }
  if (n.effects) node.effects = toEffects(n.effects, node.type !== 'TEXT');
  if (n.opacity !== undefined) node.opacity = n.opacity;
  if (n.blend) { try { node.blendMode = n.blend; } catch (e) { /* unsupported mode */ } }
  if ('clipsContent' in node) node.clipsContent = !!n.clip;
}

function makeText(n, ctx) {
  const t = figma.createText();
  const runs = n.runs.filter(r => r.text);
  t.fontName = ctx.fonts[runs[0].style];
  t.characters = runs.map(r => r.text).join('');
  let i = 0;
  for (const r of runs) {
    const s = ctx.styles[r.style], end = i + r.text.length;
    t.setRangeFontName(i, end, ctx.fonts[r.style]);
    t.setRangeFontSize(i, end, Math.max(1, s.size || 16));
    if (s.color) t.setRangeFills(i, end, [{ type: 'SOLID', color: rgb(s.color), opacity: clamp01(s.color.a) }]);
    t.setRangeLineHeight(i, end, s.lineHeight ? { unit: 'PIXELS', value: s.lineHeight } : { unit: 'AUTO' });
    t.setRangeLetterSpacing(i, end, { unit: 'PIXELS', value: s.letterSpacing || 0 });
    t.setRangeTextDecoration(i, end, s.decoration || 'NONE');
    t.setRangeTextCase(i, end, s.textCase || 'ORIGINAL');
    i = end;
  }
  t.textAlignHorizontal = n.align || 'LEFT';
  return t;
}

// Sizes a text layer after it has a parent. Single lines hug their text; wrapped text keeps the browser's width.
function sizeText(t, n, px) {
  if (n.lines > 1) {
    t.resize(Math.max(1, n.w + 2), Math.max(1, n.h));
    t.textAutoResize = 'HEIGHT';
    t.x = n.x - px - 1;
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
    const slack = n.w - t.width;
    if (n.align === 'CENTER') t.x += slack / 2;
    else if (n.align === 'RIGHT') t.x += slack;
  }
}

function makeSvg(n, svg) {
  const f = figma.createNodeFromSvg(svg);
  if (f.width > 0 && f.height > 0 && n.w > 0 && n.h > 0) {
    const s = Math.min(n.w / f.width, n.h / f.height);
    if (Math.abs(s - 1) > 0.01) f.rescale(s);
  }
  return f;
}

async function build(n, parent, px, py, ctx) {
  let node;
  try {
    if (n.type === 'TEXT') {
      if (!n.runs || !n.runs.some(r => r.text)) return null;
      node = makeText(n, ctx);
    } else if (n.type === 'SVG' || (n.type === 'IMAGE' && ctx.svgs[n.image])) {
      try {
        node = makeSvg(n, n.svg || ctx.svgs[n.image]);
      } catch (e) {
        node = figma.createRectangle(); // fall back to the rasterised copy, if any
        node.fills = ctx.hashes[n.image] ? [imagePaint(ctx.hashes[n.image], n.scale)] : PLACEHOLDER;
        ctx.svgFailed++;
      }
    } else if (n.type === 'IMAGE') {
      node = figma.createRectangle();
      const hash = ctx.hashes[n.image];
      node.fills = [...toPaints(n.fills, n.w, n.h, ctx.hashes), ...(hash ? [imagePaint(hash, n.scale)] : PLACEHOLDER)];
    } else {
      node = figma.createFrame();
      node.fills = toPaints(n.fills, n.w, n.h, ctx.hashes);
    }
    parent.appendChild(node);
    if (n.name) node.name = n.name;
    if (node.type !== 'TEXT') {
      if (node.type === 'FRAME' && n.type === 'SVG') {
        node.x = n.x - px + (n.w - node.width) / 2;
        node.y = n.y - py + (n.h - node.height) / 2;
      } else {
        node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
        node.x = n.x - px;
        node.y = n.y - py;
      }
    } else {
      node.x = n.x - px;
      node.y = n.y - py;
      sizeText(node, n, px);
    }
    if (n.type !== 'SVG') applyBox(node, n, ctx);
    else if (n.effects) node.effects = toEffects(n.effects, true);
  } catch (e) {
    ctx.errors++;
    if (ctx.errors <= 5) console.warn('html-to-figma: skipped a layer', n.type, n.name, e);
    if (!node || node.removed) return null;
    if (!node.parent || node.parent.type === 'PAGE' && parent.type !== 'PAGE') { node.remove(); return null; }
    // Placed but a style step failed: keep the layer and still build its children.
  }

  if (++ctx.count % 200 === 0) {
    figma.ui.postMessage({ type: 'progress', done: ctx.count, total: ctx.total });
    await new Promise(r => setTimeout(r, 0));
  }

  if (n.children && n.children.length && node.type === 'FRAME' && n.type === 'FRAME') {
    const built = [];
    for (const c of n.children) {
      const child = await build(c, node, n.x, n.y, ctx);
      if (child) built.push([child, c]);
    }
    if (n.layout) {
      try { applyLayout(node, n, built); } catch (e) { ctx.errors++; }
    }
  }
  return node;
}

function applyLayout(f, n, built) {
  const L = n.layout;
  f.layoutMode = L.dir;
  f.primaryAxisSizingMode = 'FIXED';
  f.counterAxisSizingMode = 'FIXED';
  [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = L.pad;
  f.itemSpacing = L.gap;
  f.primaryAxisAlignItems = L.justify;
  f.counterAxisAlignItems = L.align === 'STRETCH' ? 'MIN' : L.align;
  for (const [child, c] of built) {
    if (c.abs) {
      child.layoutPositioning = 'ABSOLUTE';
      child.x = c.x - n.x;
      child.y = c.y - n.y;
    } else if (c.stretch) child.layoutAlign = 'STRETCH';
  }
  f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
}

function countNodes(n) {
  let c = 1;
  for (const k of n.children || []) c += countNodes(k);
  return c;
}

async function importPage(p, images) {
  if (!p || p.format !== 'html-to-figma' || !p.root) throw new Error('This is not a capture from the HTML to Figma extension.');
  figma.ui.postMessage({ type: 'status', text: 'Loading fonts…' });
  const resolve = makeFontResolver(await figma.listAvailableFontsAsync());
  const fallback = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(fallback);
  const fonts = (p.styles || []).map(s => resolve(s.font));
  const unique = new Map(fonts.map(f => [f.family + '\u0000' + f.style, f]));
  const broken = new Set();
  await Promise.all([...unique].map(([k, f]) => figma.loadFontAsync(f).catch(() => broken.add(k))));
  fonts.forEach((f, i) => { if (broken.has(f.family + '\u0000' + f.style)) fonts[i] = fallback; });

  figma.ui.postMessage({ type: 'status', text: 'Adding images…' });
  const hashes = {}, svgs = {};
  let imagesFailed = 0;
  for (const [id, im] of Object.entries(images || {})) {
    if (im.svg) svgs[id] = im.svg;
    if (im.bytes) {
      try { hashes[id] = figma.createImage(im.bytes).hash; } catch (e) { if (!im.svg) imagesFailed++; }
    } else if (!im.svg) imagesFailed++;
  }

  const ctx = { styles: p.styles || [], fonts, hashes, svgs, count: 0, errors: 0, svgFailed: 0, total: countNodes(p.root) };
  const root = await build({ ...p.root, x: 0, y: 0 }, figma.currentPage, 0, 0, ctx);
  if (!root) throw new Error('Could not create the root frame.');
  root.name = p.root.name || (p.source && p.source.title) || 'Imported page';
  const c = figma.viewport.center;
  root.x = Math.round(c.x - root.width / 2);
  root.y = Math.round(c.y - Math.min(root.height, figma.viewport.bounds.height) / 2);
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  return { layers: ctx.count, errors: ctx.errors + ctx.svgFailed, missingFonts: [...resolve.missing], imagesFailed };
}

function importSvg(svg) {
  const node = figma.createNodeFromSvg(svg);
  const c = figma.viewport.center;
  node.x = Math.round(c.x - node.width / 2);
  node.y = Math.round(c.y - node.height / 2);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

if (typeof figma !== 'undefined' && figma.showUI) {
  figma.showUI(__html__, { width: 360, height: 420, themeColors: true });
  figma.ui.onmessage = async msg => {
    try {
      if (msg.type === 'import') {
        const stats = await importPage(msg.payload, msg.images);
        figma.ui.postMessage({ type: 'done', stats });
        figma.notify(`Imported ${stats.layers} layers`);
      } else if (msg.type === 'svg') {
        importSvg(msg.svg);
        figma.ui.postMessage({ type: 'done', stats: { layers: 1, errors: 0, missingFonts: [], imagesFailed: 0 } });
      }
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: (e && e.message) || String(e) });
    }
  };
}
