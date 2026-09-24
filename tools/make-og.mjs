/**
 * Renders `packages/web/assets/og.png` — the card social crawlers show for the site.
 *
 * Run from the repo root:
 *
 *     node tools/make-og.mjs
 *
 * WHY THE PNG IS COMMITTED AND THIS FILE SITS BESIDE IT
 *
 * Crawlers do not run JavaScript, so the preview cannot be drawn by the app; and
 * nothing in the deploy pipeline should depend on a font being installed, so it is
 * not generated at build time either. The PNG in `assets/` is the shipped artifact.
 * This file is its source: the geometry is derived, not remembered, and the words
 * are read out of `index.html` rather than retyped here, so an edit to the
 * `og:` tags and a rerun cannot produce an image that contradicts them.
 *
 * The one thing that is not reproducible byte-for-byte is text metrics: the stack
 * asks for the site's display font and falls back to whatever sans-serif the
 * machine has. Layout is driven by measured widths, so a substitution reflows
 * instead of overflowing, but regenerating on another machine can move a glyph by
 * a pixel. That is acceptable for a preview image and is the reason this is a tool
 * rather than a build step.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, Path2D } from '@napi-rs/canvas';
import { mulberry32 } from '../packages/web/src/geom.js';

// The canonical size for `summary_large_image`; a mismatch against this is the
// first thing `test/pure.test.js` checks.
const W = 1200;
const H = 630;

const root = new URL('../packages/web/', import.meta.url);
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');
const meta = (prop) => {
  const hit = read('index.html').match(
    new RegExp(`<meta property="og:${prop}" content="([^"]*)"`),
  );
  if (!hit) throw new Error(`index.html has no og:${prop} to draw from`);
  return hit[1];
};

// Colours transcribed from `style.css` :root and `assets/favicon.svg`, which are
// the two places the palette is defined. Hardcoded on purpose: nothing here can
// parse a stylesheet, and a value that drifts is visible in the output.
const INK = { bg0: '#020709', bg1: '#031015', fg1: '#e6edf7', fg2: '#93a3bd', fg3: '#54637e', accent: '#6fd6ff' };
const DISPLAY = '"Space Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif';
const BODY = '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif';

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// The abyss: same top-to-bottom gradient as the page behind the canvas, with the
// favicon's glow pushed up-left into it so the text column sits in light.
const bg = ctx.createLinearGradient(0, 0, 0, H);
bg.addColorStop(0, INK.bg1);
bg.addColorStop(1, INK.bg0);
ctx.fillStyle = bg;
ctx.fillRect(0, 0, W, H);
const glow = ctx.createRadialGradient(330, 250, 0, 330, 250, 760);
glow.addColorStop(0, 'rgba(111, 214, 255, 0.20)');
glow.addColorStop(1, 'rgba(111, 214, 255, 0)');
ctx.fillStyle = glow;
ctx.fillRect(0, 0, W, H);

// The mark, rasterized from the SVG the site itself ships as its icon — so this
// file cannot present a brand the favicon does not. Bytes, not text: `loadImage`
// reads a string as a URL to fetch rather than as markup to parse.
const svg = readFileSync(fileURLToPath(new URL('assets/favicon.svg', root)));
const mark = await loadImage(svg);

// The empty half of a 1200x630 frame wants the brand, not invented decoration — so
// the spiral that fills the corner is the one path lifted straight out of the icon
// above. Rasterizing the whole icon here would also have blown its own near-black
// tile up into a rectangle with visible edges across the lower right.
const spiral = svg.toString('utf8').match(/<path d="([^"]+)"/);
if (!spiral) throw new Error('favicon.svg no longer carries the spiral path this draws from');

// Marine snow, seeded so a rerun paints the same drift. Sizes and alphas are the
// same three-band shape the live canvas uses for its particle field.
const rand = mulberry32(0x5eed);
for (let i = 0; i < 150; i++) {
  const x = rand() * W;
  const y = rand() * H;
  const r = 0.6 + rand() * 2.6;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(111, 214, 255, ${(0.05 + rand() * 0.22).toFixed(3)})`;
  ctx.fill();
}

// The path is authored inside the icon's 512 box around (256, 300), so it is moved
// by placing that point rather than by guessing at offsets. It is pushed into the
// corner and kept faint: at this scale the shell reads as a shape in the water
// behind the words, and a stronger one competes with the description it sits under.
ctx.save();
ctx.translate(W - 170, H - 30);
ctx.scale(1.55, 1.55);
ctx.translate(-256, -300);
ctx.strokeStyle = 'rgba(111, 214, 255, 0.10)';
ctx.lineWidth = 9;
ctx.lineCap = 'round';
ctx.stroke(new Path2D(spiral[1]));
ctx.restore();

/** Text with tracking applied by hand: canvas has no letter-spacing everywhere. */
function tracked(text, x, y, size, weight, color, spacing) {
  ctx.font = `${weight} ${size}px ${DISPLAY}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  let at = x;
  for (const ch of text) {
    ctx.fillText(ch, at, y);
    at += ctx.measureText(ch).width + spacing;
  }
  return at - spacing - x;
}

/** Greedy word wrap against a pixel width, so a longer tagline cannot escape. */
function wrapped(text, x, y, size, lineHeight, maxWidth) {
  ctx.font = `${size}px ${BODY}`;
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const trial = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(trial).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = trial;
    }
  }
  if (line) lines.push(line);
  ctx.fillStyle = INK.fg2;
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return lines.length * lineHeight;
}

/** A rounded outline, drawn by hand because the tile's own corners are rounded. */
function roundStroke(x, y, size, r, color) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + size, y, x + size, y + size, r);
  ctx.arcTo(x + size, y + size, x, y + size, r);
  ctx.arcTo(x, y + size, x, y, r);
  ctx.arcTo(x, y, x + size, y, r);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.stroke();
}

const MARK = 196;
const MARK_X = 92;
const MARK_Y = 96;
ctx.drawImage(mark, MARK_X, MARK_Y, MARK, MARK);
// The icon carries its own near-black gradient, which on a dark page reads as a
// hole cut in the picture. A hairline of the accent is what turns it back into an
// object with an edge.
roundStroke(MARK_X + 0.5, MARK_Y + 0.5, MARK - 1, 37, 'rgba(111, 214, 255, 0.26)');

const TEXT_X = MARK_X + MARK + 46;
const TITLE_Y = MARK_Y + 104;
const title = meta('title');
// The brand is the word before the em dash in `og:title`; splitting the same
// string the crawlers read is what keeps the picture and the tag agreeing.
const [brand, ...tail] = title.split('—');
const tagline = tail.join('—').trim();
const titleSize = 96;
const titleWidth = tracked(brand.trim(), TEXT_X, TITLE_Y, titleSize, 700, INK.fg1, 6);

if (tagline) {
  ctx.font = `500 34px ${BODY}`;
  ctx.fillStyle = INK.accent;
  ctx.fillText(tagline, TEXT_X, TITLE_Y + 56);
}

const ruleY = TITLE_Y + 96;
ctx.strokeStyle = 'rgba(120, 160, 220, 0.22)';
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(MARK_X, ruleY + 0.5);
ctx.lineTo(W - MARK_X, ruleY + 0.5);
ctx.stroke();

const bodyLines = wrapped(
  meta('description'), MARK_X, ruleY + 70, 34, 50, W - MARK_X * 2,
);

const footY = H - 74;
ctx.font = `500 26px ${BODY}`;
ctx.fillStyle = INK.fg3;
ctx.fillText('https://www.abyssal-arc.com', MARK_X, footY);
// The title has to clear the rule it hangs above, and the footer has to clear the
// description it sits under, or the layout is wrong and the numbers above were
// chosen by luck rather than by measurement.
if (TITLE_Y + 56 > ruleY) throw new Error('the tagline would sit on the rule');
if (footY - 30 < ruleY + 70 + bodyLines) throw new Error('the footer would collide with the description');
if (titleWidth > W - TEXT_X - 40) throw new Error(`the wordmark is ${titleWidth}px wide and would be clipped`);

writeFileSync(fileURLToPath(new URL('assets/og.png', root)), canvas.toBuffer('image/png'));
console.log(`wrote packages/web/assets/og.png ${W}x${H} — title "${brand.trim()}", ${bodyLines / 50} lines of description`);
