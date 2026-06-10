/**
 * Shared primitives for generating 1200x630 social-share (OG) cards with sharp.
 *
 * Text is rendered to vector paths via opentype.js rather than relying on
 * system fonts — sharp's bundled fontconfig won't reliably find ad-hoc font
 * dirs, and our brand font (Fraunces) isn't installed on macOS or CI. See
 * pathToD() for the toPathData() NaN workaround.
 *
 * Used by generate-episode-og.mjs (episode + podcast cards) and
 * generate-page-og.mjs (per-page cards).
 */

import { readFileSync } from 'fs';
import sharp from 'sharp';
import opentype from 'opentype.js';

export const W = 1200;
export const H = 630;

export function loadFont(path) {
  const buf = readFileSync(path);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function measure(font, text, fontSize) {
  return font.getAdvanceWidth(text, fontSize);
}

// Build SVG path data straight from opentype's parsed commands. We deliberately
// avoid path.toPathData(): its number formatter emits a literal "NaN" token for
// some coordinate values in this font (the underlying command values are fine),
// which silently breaks glyphs. Formatting the clean command numbers ourselves
// sidesteps that bug entirely.
const round2 = (n) => Number(n.toFixed(2));
export function pathToD(path) {
  let d = '';
  for (const c of path.commands) {
    if (c.type === 'M') d += `M${round2(c.x)} ${round2(c.y)}`;
    else if (c.type === 'L') d += `L${round2(c.x)} ${round2(c.y)}`;
    else if (c.type === 'C') d += `C${round2(c.x1)} ${round2(c.y1)} ${round2(c.x2)} ${round2(c.y2)} ${round2(c.x)} ${round2(c.y)}`;
    else if (c.type === 'Q') d += `Q${round2(c.x1)} ${round2(c.y1)} ${round2(c.x)} ${round2(c.y)}`;
    else if (c.type === 'Z') d += 'Z';
  }
  return d;
}

// One <path> per text line. A single giant `d` attribute (all lines/glyphs
// concatenated) gets truncated by librsvg's XML parser, dropping later lines;
// per-line paths keep each attribute small and render reliably.
export function lineToPath(font, text, x, baseline, fontSize, color, opacity = 1) {
  const d = pathToD(font.getPath(text, x, baseline, fontSize));
  const op = opacity === 1 ? '' : ` fill-opacity="${opacity}"`;
  return `<path d="${d}" fill="${color}"${op}/>`;
}

// A single line rendered with extra letter-spacing (tracking, in px). Useful
// for uppercase eyebrow/label text. opentype has no native tracking, so we
// place each glyph by hand. Returns one <path> (labels are short — no
// attribute-length risk).
export function trackedWidth(font, text, fontSize, tracking) {
  let w = 0;
  for (const ch of [...text]) w += font.getAdvanceWidth(ch, fontSize) + tracking;
  return w - tracking;
}
export function trackedLine(font, text, x, baseline, fontSize, color, tracking, opacity = 1) {
  let cx = x;
  let d = '';
  for (const ch of [...text]) {
    if (ch !== ' ') d += pathToD(font.getPath(ch, cx, baseline, fontSize));
    cx += font.getAdvanceWidth(ch, fontSize) + tracking;
  }
  const op = opacity === 1 ? '' : ` fill-opacity="${opacity}"`;
  return `<path d="${d}" fill="${color}"${op}/>`;
}

export function wrapToWidth(font, text, fontSize, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    if (!current || measure(font, candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Largest font size at which the wrapped text fits the box (width + height).
export function fitText(font, text, { maxWidth, maxHeight, maxFs = 72, minFs = 34, lineRatio = 1.18 }) {
  for (let fs = maxFs; fs >= minFs; fs -= 1) {
    const lines = wrapToWidth(font, text, fs, maxWidth);
    const totalH = lines.length * fs * lineRatio;
    const overflow = lines.some((l) => measure(font, l, fs) > maxWidth);
    if (totalH <= maxHeight && !overflow) return { fs, lines };
  }
  return { fs: minFs, lines: wrapToWidth(font, text, minFs, maxWidth) };
}

// Render a wrapped, auto-fit text block, vertically centered in its box.
// Returns the concatenated <path> string plus layout metrics (so callers can
// position things relative to it). Does NOT wrap in <svg>.
export function textBlock(font, text, opts) {
  const {
    x, top, width, height,
    align = 'left', color = '#ffffff', opacity = 1,
    maxFs = 72, minFs = 34, lineRatio = 1.18,
  } = opts;
  const { fs, lines } = fitText(font, text, { maxWidth: width, maxHeight: height, maxFs, minFs, lineRatio });
  const lineHeight = fs * lineRatio;
  const ascent = (font.ascender / font.unitsPerEm) * fs;
  const totalH = lines.length * lineHeight;
  const startBaseline = top + (height - totalH) / 2 + ascent;

  const paths = lines
    .map((line, i) => {
      const lineX = align === 'center' ? x + (width - measure(font, line, fs)) / 2 : x;
      return lineToPath(font, line, lineX, startBaseline + i * lineHeight, fs, color, opacity);
    })
    .join('');

  return { paths, fs, lines, lineHeight, totalH, startBaseline };
}

// Wrap inner SVG markup in a full-canvas <svg> buffer for sharp compositing.
export function svgLayer(inner) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${inner}</svg>`);
}

// The zebra texture, zoomed in (so the weave reads at preview size) and lightly
// blurred, cropped back to WxH from a magnified canvas.
export async function zebraBackground(bgPath, { zoom = 1.7, blur = 5, brightness = 0.92 } = {}) {
  const zw = Math.round(W * zoom);
  const zh = Math.round(H * zoom);
  const zoomed = await sharp(bgPath)
    .resize(zw, zh, { fit: 'cover' })
    .blur(blur)
    .modulate({ brightness })
    .toBuffer();
  return sharp(zoomed)
    .extract({
      left: Math.round((zw - W) / 2),
      top: Math.round((zh - H) / 2),
      width: W,
      height: H,
    })
    .toBuffer();
}
