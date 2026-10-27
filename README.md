# HTML to Figma

Copy any web page, or part of one, into Figma as **editable layers**: frames, text you can retype, vector icons, images, gradients, shadows, and optionally Auto Layout.

It is free to run. There's no server, no account and no API key. Everything happens in your browser and in Figma.

```
Chrome extension ──(click)──> reads the rendered page ──> clipboard ──> Ctrl+V on the Figma canvas ──> layers
```

By default the extension copies the page as SVG code. Figma's canvas turns pasted SVG into vectors, editable text, groups and masks, so **you only need the extension**. The optional Figma plugin gives higher fidelity: real frames, Auto Layout, and automatic font substitution.

| Folder | What it is |
|---|---|
| `extension/` | Chrome extension (Manifest V3). Reads the live page and copies it as SVG (for the canvas) or JSON (for the plugin). |
| `figma-plugin/` | Optional Figma plugin. You paste the JSON and it builds native frames. |
| `test/` | `fixture.html` (a page that uses every supported feature) and `plugin.test.js` (runs the plugin against a fake Figma). |

## Install (about 2 minutes)

**Chrome extension**
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension` folder.
3. Pin the extension so its button is always visible.

**Figma plugin**: optional. Only needed for the "Copy for the Figma plugin" output. It requires the Figma desktop app, because the browser version can't load local plugins.
1. In any Figma design file: **Menu → Plugins → Development → Import plugin from manifest…**
2. Choose `figma-plugin/manifest.json`.

## Use

1. On any web page, click the extension button and choose **Full page**, **Visible area** or **Pick an element**, then **Capture**.
   - Pick mode: hover to highlight, press **↑** to select the parent, **click** or **Enter** to copy, **Esc** to cancel.
   - Keyboard shortcut: **Alt+Shift+F** copies the full page using your saved options.
2. In Figma (desktop or browser), click the canvas and press **Ctrl+V** (⌘V on Mac). Done.

### Output choices (in the popup)
- **Paste straight onto the Figma canvas** (default): no plugin needed. You get vectors, editable text (wrapped exactly where the browser wrapped it), gradients, borders, drop shadows, images and vector icons, grouped and named after the page's elements.
- **Copy for the Figma plugin**: real frames instead of groups, optional Auto Layout, and the plugin swaps in an available font when Figma doesn't have the page's font. Run **Plugins → Development → HTML to Figma**, click its window and press Ctrl+V.
- **Download .json for the plugin**: use this for very large pages. Drop the file onto the plugin window.

When you paste on the canvas and Figma doesn't have the page's font, Figma marks it as a missing font. Install the font, or pick a replacement in Figma's missing-font dialog.

### Options
- **Scroll first to load lazy images**: scrolls the page to the bottom and back before capturing, so lazy-loaded images and sections are included.
- **Remove empty wrapper layers**: drops `<div>`s that draw nothing and only wrap one child. This gives a much cleaner layers panel.
- **Turn flexbox into Auto Layout** (plugin output only): only used where the result will look the same: single-line flex rows or columns with even spacing.

## What gets converted

| Web | Figma |
|---|---|
| Elements with background, border, radius, shadow, opacity, blend mode | Frames with fills, inside strokes (per side), corner radius (per corner), drop and inner shadows |
| Text (including bold, italic, links and colour inside one paragraph) | One text layer per paragraph with styled ranges: font, size, weight, colour, line height, letter spacing, underline/strikethrough, upper/lower/title case |
| Linear, radial and conic gradients; `oklch()`, `color()`, `hsl()` colours | Linear, radial and angular gradient fills |
| `<img>`, CSS background images, `<canvas>`, `<video>` frame | Image fills (`object-fit` / `background-size` map to Fill, Fit, Tile or Stretch) |
| Inline `<svg>` and `.svg` images | Editable vector layers (with a raster fallback) |
| `::before` / `::after` (badges, decorations, icon fonts) | Frames and text; icon-font glyphs are copied as crisp images |
| List bullets and numbers, inputs, placeholders, checkboxes, radios, selects | Matching layers |
| Same-origin iframes, open Shadow DOM, `display: contents` | Followed and included |
| `filter: blur()`, `backdrop-filter: blur()` | Layer blur, background blur |
| Flexbox (opt-in) | Auto Layout with padding, gap and alignment; absolutely positioned children stay absolute |

Fonts: the plugin uses the page's font if Figma has it. Otherwise it falls back down the CSS font stack, then to Inter. When it's done, it lists every font it had to replace. Install those fonts locally and import again for an exact match.

## Known limits

These are deliberate simplifications. Each has a clear way to improve it later.

- Rotated or skewed elements come in as their straight bounding box, without the rotation.
- `z-index` is ordered among siblings only, not across nested stacking contexts.
- `mask-image`, `clip-path` and exact `background-position` are not reproduced.
- `::before` / `::after` positions are calculated rather than measured, so they can be off by a few pixels. `url()` and `counter()` content is skipped.
- Cross-origin iframes and closed Shadow DOM show as placeholders, because the browser hides their contents.
- Apps whose page body never scrolls (the scrolling happens inside a panel) only capture the visible height. Use **Pick an element** on the scrolling panel instead.
- Limits per capture: 30,000 elements, 10 MB per image, 30 MB of images in total. Beyond that, images become grey placeholders and the page is cut short with a warning.
- Chrome blocks every extension on `chrome://` pages, the Chrome Web Store and the PDF viewer.

## Develop & test

```bash
node test/plugin.test.js                 # gradient maths, font matching, and a full import into a fake Figma
node test/plugin.test.js capture.json    # also import a real capture (use "Download .json file" to get one)
```

To try the capture script without the extension: serve this folder (`python -m http.server 8765`), open `http://localhost:8765/test/fixture.html`, then run this in the console:

```js
await window.__h2f.capture({ mode: 'full' })
```

How the pieces fit:
- `extension/capture.js` is injected into the page. It walks the rendered page and reads the browser's computed styles and on-screen positions. It outputs a tree of `FRAME` / `TEXT` / `IMAGE` / `SVG` nodes in CSS pixels, plus shared text styles and an image list.
- `extension/svg.js` turns that tree into one SVG document for pasting on the canvas (line-by-line text, gradients, Figma-style shadow filters, clip masks, embedded icons).
- `extension/background.js` downloads the images. The extension's host permission means no cross-site blocking (CORS) gets in the way. It then copies the result to the clipboard (via `offscreen.html`) or downloads it.
- `figma-plugin/ui.html` reads the paste and converts images Figma can't take (WebP, AVIF, SVG, anything over 4096 px) into PNG or JPEG.
- `figma-plugin/code.js` loads the fonts and builds the layers. If one layer fails, it skips that layer and keeps going.

## Publishing (optional)

- **Chrome Web Store**: one-time $5 developer fee. Add 16/48/128 px icons to `manifest.json` first. The `<all_urls>` permission is needed to download a page's images, so explain that in the listing.
- **Figma Community**: free. Create the plugin from Figma (**Plugins → Development → New plugin**) to get a real `id`, put that id in `figma-plugin/manifest.json`, then publish from the desktop app.
