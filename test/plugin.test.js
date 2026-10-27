// Runs the Figma plugin against a fake Figma API.  Usage: node test/plugin.test.js [capture.json]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = vm.createContext({ console, setTimeout, Promise });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../figma-plugin/code.js'), 'utf8'), ctx);
const { linearTransform, pickStyle, makeFontResolver, importPage } = ctx;

const apply = (m, x, y) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// --- gradients: CSS "to bottom" (180deg) runs top→bottom; Figma's unit gradient runs (0,.5)→(1,.5)
let m = linearTransform(180, 200, 100);
near(apply(m, 0.5, 0)[0], 0, '180deg start');
near(apply(m, 0.5, 1)[0], 1, '180deg end');
m = linearTransform(90, 200, 100);
near(apply(m, 0, 0.5)[0], 0, '90deg start');
near(apply(m, 1, 0.5)[0], 1, '90deg end');
// 30deg on a non-square box: colour bands must be perpendicular to the gradient direction in pixels.
const w = 300, h = 100, a = (30 * Math.PI) / 180;
m = linearTransform(30, w, h);
const perp = { x: Math.cos(a) / w, y: Math.sin(a) / h };
near(apply(m, 0.5, 0.5)[0], apply(m, 0.5 + perp.x * 20, 0.5 + perp.y * 20)[0], '30deg bands perpendicular');
near(apply(m, 0.5, 0.5)[0], 0.5, '30deg centre at midpoint');

// --- fonts
const styles = ['Regular', 'Italic', 'Light', 'Semi Bold', 'Bold', 'Bold Italic', 'ExtraBold'];
assert.strictEqual(pickStyle(styles, 600, false), 'Semi Bold');
assert.strictEqual(pickStyle(styles, 700, true), 'Bold Italic');
assert.strictEqual(pickStyle(styles, 300, false), 'Light');
assert.strictEqual(pickStyle(styles, 800, false), 'ExtraBold');
assert.strictEqual(pickStyle(styles, 400, true), 'Italic');

const available = [];
for (const family of ['Inter', 'Arial', 'Roboto Mono']) for (const style of styles) available.push({ fontName: { family, style } });
const resolve = makeFontResolver(available);
assert.deepStrictEqual({ ...resolve({ families: ['Helvetica Neue', 'Arial', 'sans-serif'], weight: 700, italic: false }) }, { family: 'Arial', style: 'Bold' });
assert.deepStrictEqual({ ...resolve({ families: ['system-ui'], weight: 400, italic: false }) }, { family: 'Inter', style: 'Regular' });
assert.deepStrictEqual({ ...resolve({ families: ['ui-monospace', 'monospace'], weight: 400, italic: false }) }, { family: 'Roboto Mono', style: 'Regular' });
assert.deepStrictEqual({ ...resolve({ families: ['Nope'], weight: 400, italic: false }) }, { family: 'Inter', style: 'Regular' });
assert.ok(resolve.missing.has('Helvetica Neue') && resolve.missing.has('Nope') && !resolve.missing.has('system-ui'));

// --- a fake Figma, just enough for importPage
class Node {
  constructor(type) { Object.assign(this, { type, name: type, x: 0, y: 0, width: 100, height: 100, children: [], parent: null, removed: false, fills: [], effects: [] }); }
  appendChild(c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); }
  resize(w, h) { assert.ok(w > 0 && h > 0, 'resize must be positive'); this.width = w; this.height = h; }
  rescale(s) { this.width *= s; this.height *= s; }
  remove() { this.removed = true; if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
}
class Frame extends Node {
  constructor() { super('FRAME'); this.clipsContent = true; this.strokes = []; this.topLeftRadius = 0; this.strokeTopWeight = 0; this.layoutMode = 'NONE'; }
}
class Text extends Node {
  constructor() { super('TEXT'); this._chars = ''; this.textAutoResize = 'NONE'; this.ranges = []; this.strokes = []; }
  set fontName(f) { assert.ok(loaded.has(f.family + '/' + f.style), `font not loaded: ${f.family} ${f.style}`); this._font = f; }
  get fontName() { return this._font; }
  set characters(s) { assert.ok(this._font, 'set fontName before characters'); this._chars = s; this.width = s.length * 7; this.height = 18; }
  get characters() { return this._chars; }
}
for (const fn of ['FontName', 'FontSize', 'Fills', 'LineHeight', 'LetterSpacing', 'TextDecoration', 'TextCase']) {
  Text.prototype['setRange' + fn] = function (s, e, v) {
    assert.ok(s >= 0 && e <= this._chars.length && s < e, `bad range ${s}-${e} of ${this._chars.length}`);
    if (fn === 'FontName') assert.ok(loaded.has(v.family + '/' + v.style), 'range font not loaded');
    this.ranges.push([fn, s, e, v]);
  };
}
const loaded = new Set();
const page = new Node('PAGE');
const all = [];
const track = n => { page.appendChild(n); all.push(n); return n; };
ctx.figma = {
  currentPage: page,
  viewport: { center: { x: 0, y: 0 }, bounds: { height: 800 }, scrollAndZoomIntoView() {} },
  ui: { postMessage() {} },
  listAvailableFontsAsync: async () => available,
  loadFontAsync: async f => { if (!available.some(a => a.fontName.family === f.family && a.fontName.style === f.style)) throw new Error('no font'); loaded.add(f.family + '/' + f.style); },
  createFrame: () => track(new Frame()),
  createText: () => track(new Text()),
  createRectangle: () => track(Object.assign(new Node('RECTANGLE'), { strokes: [], topLeftRadius: 0 })),
  createNodeFromSvg: svg => { if (!svg.includes('<svg')) throw new Error('bad svg'); const f = track(new Frame()); const wm = svg.match(/width="([\d.]+)"/); f.width = wm ? +wm[1] : 24; f.height = f.width; return f; },
  createImage: bytes => ({ hash: 'h' + bytes.length }),
};

const sample = {
  format: 'html-to-figma', version: 1, source: { title: 'Sample' },
  styles: [
    { font: { families: ['Helvetica Neue', 'Arial', 'sans-serif'], weight: 700, italic: false }, size: 32, color: { r: 0, g: 0, b: 0, a: 1 }, lineHeight: 40, letterSpacing: 0, decoration: 'NONE', textCase: 'ORIGINAL' },
    { font: { families: ['system-ui'], weight: 400, italic: true }, size: 16, color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, lineHeight: null, letterSpacing: 0.5, decoration: 'UNDERLINE', textCase: 'UPPER' },
  ],
  root: {
    type: 'FRAME', name: 'Sample', x: 0, y: 0, w: 800, h: 600, clip: true, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [
      { type: 'TEXT', name: 'Title', x: 40, y: 40, w: 300, h: 40, lines: 1, align: 'CENTER', runs: [{ text: 'Hello ', style: 0 }, { text: 'world', style: 1 }] },
      { type: 'TEXT', name: 'Para', x: 40, y: 100, w: 300, h: 60, lines: 3, align: 'LEFT', runs: [{ text: 'Wrapped text here', style: 1 }] },
      {
        type: 'FRAME', name: 'card', x: 40, y: 200, w: 300, h: 150, clip: true, radius: [12, 12, 0, 0],
        stroke: { color: { r: 0, g: 0, b: 0, a: 0.1 }, weights: [1, 1, 2, 1], style: 'solid' },
        fills: [{ type: 'LINEAR', angle: 135, stops: [{ pos: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { pos: 1, color: { r: 0, g: 0, b: 1, a: 0 } }] }, { type: 'IMAGE', image: 'i0', scale: 'FILL' }],
        effects: [{ type: 'SHADOW', inset: false, x: 0, y: 4, blur: 12, spread: 2, color: { r: 0, g: 0, b: 0, a: 0.2 } }, { type: 'BACKGROUND_BLUR', radius: 8 }],
        layout: { dir: 'HORIZONTAL', gap: 8, pad: [10, 10, 10, 10], justify: 'MIN', align: 'STRETCH' },
        children: [
          { type: 'IMAGE', name: 'photo', x: 50, y: 210, w: 100, h: 130, image: 'i0', scale: 'STRETCH', fills: [], stretch: 1 },
          { type: 'IMAGE', name: 'logo', x: 158, y: 210, w: 40, h: 40, image: 'i1', scale: 'FIT', fills: [] },
          { type: 'SVG', name: 'icon', x: 300, y: 210, w: 24, h: 24, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>', abs: 1 },
          { type: 'IMAGE', name: 'broken', x: 206, y: 210, w: 40, h: 40, image: 'missing', scale: 'FILL', fills: [] },
        ],
      },
    ],
  },
};
const images = { i0: { bytes: new Uint8Array(10) }, i1: { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"></svg>', bytes: new Uint8Array(5) } };

(async () => {
  const stats = await importPage(sample, images);
  const root = page.children.find(n => n.name === 'Sample');
  assert.ok(root && root.width === 800 && root.clipsContent === true);
  assert.strictEqual(stats.errors, 0, 'no layer errors');
  assert.strictEqual(stats.layers, 8);
  assert.ok(stats.missingFonts.includes('Helvetica Neue'));
  const [title, para, card] = root.children;
  assert.strictEqual(title.characters, 'Hello world');
  assert.strictEqual(title.textAutoResize, 'WIDTH_AND_HEIGHT');
  near(title.x, 40 + (300 - title.width) / 2, 'centred single line');
  assert.strictEqual(para.textAutoResize, 'HEIGHT');
  assert.strictEqual(para.width, 302);
  assert.ok(title.ranges.some(r => r[0] === 'TextCase' && r[1] === 6 && r[3] === 'UPPER'));
  assert.strictEqual(card.x, 40);
  assert.strictEqual(card.layoutMode, 'HORIZONTAL');
  assert.strictEqual(card.itemSpacing, 8);
  assert.deepStrictEqual([card.topLeftRadius, card.bottomRightRadius], [12, 0]);
  assert.deepStrictEqual([card.strokeTopWeight, card.strokeBottomWeight], [1, 2]);
  assert.strictEqual(card.fills[0].type, 'GRADIENT_LINEAR');
  assert.strictEqual(card.fills[1].imageHash, 'h10');
  assert.strictEqual(card.effects[0].type, 'DROP_SHADOW');
  assert.strictEqual(card.effects[0].spread, 2);
  const [photo, logo, icon, broken] = card.children;
  assert.deepStrictEqual([photo.x, photo.y, photo.fills[0].scaleMode], [10, 10, 'CROP']);
  assert.strictEqual(photo.layoutAlign, 'STRETCH');
  assert.strictEqual(logo.type, 'FRAME', 'svg image becomes a vector frame');
  assert.strictEqual(Math.round(logo.width), 40, 'vector scaled to fit');
  assert.strictEqual(icon.layoutPositioning, 'ABSOLUTE');
  assert.strictEqual(icon.x, 260);
  assert.strictEqual(broken.fills[0].type, 'SOLID', 'missing image shows a placeholder');

  // Optional: a real capture saved from the extension.
  const file = process.argv[2];
  if (file) {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    const imgs = {};
    for (const [id, im] of Object.entries(p.images || {})) imgs[id] = im.svg ? { svg: im.svg, bytes: new Uint8Array(4) } : im.data ? { bytes: new Uint8Array(4) } : {};
    const s = await importPage(p, imgs);
    console.log(`capture ${path.basename(file)}: ${s.layers} layers, ${s.errors} errors, missing fonts: ${s.missingFonts.join(', ') || 'none'}`);
    assert.strictEqual(s.errors, 0, 'real capture imports without layer errors');
  }
  // --- direct-paste SVG: wrapped text splits at the browser's break points, layers get readable ids
  const toFigmaSvg = require('../extension/svg.js');
  const wrapped = { ...sample.root.children[1], breaks: [8], runs: [{ text: 'Wrapped text & here', style: 0 }] };
  const svg = toFigmaSvg({ ...sample, images: { i0: { data: 'data:image/png;base64,AAAA' } }, root: { ...sample.root, children: [wrapped, sample.root.children[2]] } });
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.ok(/<tspan x="40" y="[\d.]+">Wrapped<\/tspan><tspan x="40" y="[\d.]+">text &amp; here<\/tspan>/.test(svg), 'lines split at breaks, text escaped');
  assert.ok(svg.includes(`font-family="'Helvetica Neue', Arial, sans-serif"`));
  assert.ok(svg.includes('id="card"') && svg.includes('<linearGradient') && svg.includes('feGaussianBlur'));
  console.log('plugin tests passed');
})().catch(e => { console.error(e); process.exit(1); });
