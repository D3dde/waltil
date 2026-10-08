/* waltil — client-side limited-color wallpaper maker.
   Pipeline: gray (rec.709) -> [quantize: black/white] -> invert
           -> quantize -> palette ramp (stops).
   Everything runs in this tab; no network calls. */
'use strict';

const $ = (sel) => document.querySelector(sel);

/* ---------------------------------------------------------------- palettes
   Every preset is a 2-stop ramp (dark, light): quantize interpolates
   smoothly between exactly two ends. With more stops, quantize steps
   through every stop. */

const PRESETS = {
  mono:      ['#000000', '#FFFFFF'],
  rust:      ['#4A0E17', '#FDE8D0'],
  cyanotype: ['#0B1D3A', '#DCE9FF'],
  sepia:     ['#29170B', '#F7E3C1'],
  ink:       ['#111111', '#F4F1EA'],
  terminal:  ['#06120A', '#4DFF88'],
  ember:     ['#1A0600', '#FF9B3D'],
  nord:      ['#2E3440', '#ECEFF4'],
  gruvbox:   ['#282828', '#FBF1C7'],
  dracula:   ['#21222C', '#F8F8F2'],
  solarized: ['#002B36', '#FDF6E3'],
  ocean:     ['#041527', '#E1F5FE'],
  sunset:    ['#2B1055', '#FFE29F'],
  forest:    ['#0B2818', '#E8F5E9'],
  neon:      ['#0F001A', '#00F0FF'],
  blueprint: ['#0A1F44', '#F0F6FF'],
};

/* preview caps: max height. 0 = render at the original size (lossless). */
const PREVIEW_QUALITIES = [720, 1080, 1440, 0];

const QUALITY_LABEL = { 720: '720p', 1080: '1080p', 1440: '1440p', 0: 'lossless' };

const DEFAULTS = {
  black: 0,
  white: 100,
  invert: false,
  levels: 4,
  dither: 'none',
  ditherStrength: 100,
  stops: PRESETS.mono.slice(),
  preset: 'mono',
  previewQuality: 1080,
};

/* numeric ranges used both for clamping UI input and for sanitizing saved state */
const NUMS = {
  black:          { min: 0,   max: 100, digits: 0 },
  white:          { min: 0,   max: 100, digits: 0 },
  levels:         { min: 2,   max: 16,  digits: 0 },
  ditherStrength: { min: 0,   max: 100, digits: 0 },
  'dither-strength': { min: 0,   max: 100, digits: 0 },
};

const DITHERS = ['none', 'fs', 'atkinson', 'bayer4', 'noise'];

const DIFFUSION = {
  fs: { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  atkinson: { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
};

const BAYER4 = [
  0, 8, 2, 10, 12, 4, 14, 6,
  3, 11, 1, 9, 15, 7, 13, 5,
];

const STORAGE_KEY = 'waltil.settings.v1';

const state = {
  source: null,
  srcId: 0,
  fileName: 'wallpaper',
  origW: 0,
  origH: 0,
  previewW: 0,
  previewH: 0,
  compare: false,
  params: freshParams(),
};

const view = { z: 1, x: 0, y: 0 };

const preview = $('#preview');
const pctx = preview.getContext('2d');
const wrap = $('#canvas-wrap');

/* preview pipeline buffers (reused between renders) */
const srcCanvas = document.createElement('canvas');
const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
let srcPixels = null;      /* ImageData of the source at preview size */
let srcKey = '';
let srcBuild = null;       /* in-flight build promise */
let srcBuildKey = '';
let work = null;           /* ImageData scratch buffer for processed pixels */
let renderToken = 0;

let rafPending = false;
let exportBusy = false;
let saveTimer = 0;

/* cached parsed stops to avoid re-parsing on every render */
let stopsCache = { key: '', stops: null };

/* cached quantization LUTs per levels value (2-16) */
const quantLUTCache = new Map();

/* ---------------------------------------------------------------- utils */

function freshParams() { return { ...DEFAULTS, stops: DEFAULTS.stops.slice() }; }

function getParsedStops(stops) {
  const key = stops.join(',');
  if (stopsCache.key === key && stopsCache.stops) return stopsCache.stops;
  const parsed = stops.map(parseHex).filter(Boolean);
  stopsCache.key = key;
  stopsCache.stops = parsed;
  return parsed;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function clampNum(v, key) {
  const r = NUMS[key];
  const out = clamp(v, r.min, r.max);
  return r.digits ? Number(out.toFixed(r.digits)) : Math.round(out);
}

function fmtNum(key, v) {
  const r = NUMS[key];
  return r.digits ? Number(v).toFixed(r.digits) : String(Math.round(v));
}

function parseHex(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb) {
  return '#' + rgb.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function sameStops(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((c, i) => String(c).toUpperCase() === String(b[i]).toUpperCase());
}

/* WCAG relative luminance */
function relLum(r, g, b) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.212656 * f(r) + 0.715158 * f(g) + 0.072186 * f(b);
}

let toastTimer = 0;

/**
 * Shows a toast notification.
 * @param {string} msg - The message to display.
 * @param {boolean} [isError=false] - Whether the toast is an error.
 */
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/**
 * Sets the status bar message.
 * @param {string} msg - The message to display.
 */
function setStatus(msg) { $('#status').textContent = msg; }

function updateDitherStrengthState() {
  const hidden = $('#dither').value === 'none';
  const field = $('#dither-strength').closest('.field');
  if (field) field.hidden = hidden;
  $('#dither-strength').disabled = hidden;
  $('#dither-strength-num').disabled = hidden;
}

/**
 * Updates the accent color based on the second color stop.
 * Also updates the favicon and logo.
 */
function applyAccent() {
  const stops = state.params.stops;
  if (stops.length < 2) return;
  const hex = stops[1];
  const rgb = parseHex(hex);
  if (!rgb) return;

  let [r, g, b] = rgb;
  let L = relLum(r, g, b);
  /* keep it readable on the dark background */
  for (let k = 0; L < 0.16 && k < 5; k++) {
    r += (255 - r) * 0.3;
    g += (255 - g) * 0.3;
    b += (255 - b) * 0.3;
    L = relLum(r, g, b);
  }

  /* whichever of white / near-black reads better on this accent */
  const cw = 1.05 / (L + 0.05);
  const cb = (L + 0.05) / 0.0575;
  const ink = cb >= cw ? '#15151a' : '#ffffff';

  const root = document.documentElement.style;
  root.setProperty('--accent', `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`);
  root.setProperty('--accent-ink', ink);
  updateFavicon();
}

function updateFavicon() {
  const stops = state.params.stops;
  if (stops.length < 2) return;
  const dark = stops[0];
  const light = stops[stops.length - 1];
  const svg = makeLogoSVG(dark, light);
  const href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  let link = document.querySelector("link[rel*='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
  updateLogo(dark, light);
}

function makeLogoSVG(dark, light) {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><clipPath id='c'><rect x='1' y='1' width='30' height='30' rx='8'/></clipPath></defs><g clip-path='url(#c)'><rect width='32' height='32' fill='${dark}'/><path d='M16 0 32 0 0 32 0 16Z' fill='${light}'/><path d='M0 0 16 0 0 16Z' fill='${dark}'/></g><rect x='1' y='1' width='30' height='30' rx='8' fill='none' stroke='#000' stroke-opacity='.4' stroke-width='2'/></svg>`;
}

function updateLogo(dark, light) {
  const logoEl = $('#logo');
  if (logoEl) logoEl.innerHTML = makeLogoSVG(dark, light);
}

/* ------------------------------------------------------------ persistence */

function sanitizeParams(raw) {
  const p = freshParams();
  if (!raw || typeof raw !== 'object') return p;
  const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

  for (const key of Object.keys(NUMS)) {
    const v = Number(raw[key]);
    if (Number.isFinite(v)) p[key] = clampNum(v, key);
  }
  p.invert = raw.invert === true;
  p.dither = oneOf(raw.dither === 'bayer' ? 'bayer4' : raw.dither, DITHERS, DEFAULTS.dither);

  const q = Number(raw.previewQuality);
  p.previewQuality = Number.isFinite(q) && PREVIEW_QUALITIES.includes(q)
    ? q : DEFAULTS.previewQuality;

  if (Array.isArray(raw.stops)) {
    const stops = raw.stops.slice(0, 8).map(parseHex).filter(Boolean).map(toHex);
    if (stops.length >= 2) p.stops = stops;
  }
  p.preset = (typeof raw.preset === 'string' && PRESETS.hasOwnProperty(raw.preset))
    ? raw.preset : '';
  if (p.preset && !sameStops(p.stops, PRESETS[p.preset])) p.preset = '';
  return p;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.params = sanitizeParams(JSON.parse(raw));
  } catch { /* corrupted or unavailable storage — fall back to defaults */ }
}

function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.params)); } catch { /* quota / private mode */ }
  }, 250);
}

function saveSettingsNow() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.params)); } catch { /* quota / private mode */ }
}

/* every parameter change goes through here: recolor, re-render, persist */
function touch() { applyAccent(); scheduleRender(); saveSettings(); }

function markCustom() {
  state.params.preset = '';
  $('#preset').value = '';
  updateCustomSelectUI();
}

function updateCustomSelectUI() {
  const triggerSwatches = $('#preset-trigger-swatches');
  const triggerText = $('#preset-trigger-text');
  const options = $('#preset-options').querySelectorAll('.custom-select-option');
  
  triggerText.textContent = 'Custom';
  triggerSwatches.innerHTML = '';
  options.forEach(o => o.setAttribute('aria-selected', 'false'));
}

/* ---------------------------------------------------------------- source
   Preview quality: the stored preference is only honored when the image can
   actually use it; otherwise fall back to 1080p, or lossless on images that
   are already at most 1920 on the long edge. */

function availableQualities() {
  if (!state.source) return PREVIEW_QUALITIES.slice();
  const maxH = state.origH || 1;
  return PREVIEW_QUALITIES.filter((q) => q === 0 || q < maxH);
}

function effectiveQuality() {
  const avail = availableQualities();
  const pref = state.params.previewQuality;
  if (avail.includes(pref)) return pref;
  const maxH = state.origH || 1;
  const def = maxH <= 1080 ? 0 : 1080;
  if (avail.includes(def)) return def;
  return 0;
}

function updateQualityOptions() {
  const avail = availableQualities();
  const sel = $('#preview-quality');
  for (const opt of sel.options) opt.hidden = !avail.includes(Number(opt.value));
  sel.value = String(effectiveQuality());
}

function updatePreviewSize() {
  if (!state.source) return;
  const q = effectiveQuality();
  updateQualityOptions();
  const scale = q === 0 ? 1 : Math.min(1, q / (state.origH || 1));
  state.previewW = Math.max(1, Math.round(state.origW * scale));
  state.previewH = Math.max(1, Math.round(state.origH * scale));
  preview.width = state.previewW;
  preview.height = state.previewH;
  work = null;
  $('#meta-preview').textContent =
    `${state.previewW} × ${state.previewH} · ${QUALITY_LABEL[q] || q}`;
  resetView();
}

async function blobToSource(blob) {
  if (!blob) throw new Error('No blob provided');

  if (blob instanceof ImageBitmap) return blob;
  if (blob instanceof HTMLImageElement) {
    try { return await createImageBitmap(blob); } catch { return blob; }
  }

  try {
    return await createImageBitmap(blob);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Loads an image blob and sets it as the source.
 * @param {Blob|File} blob - The image blob to load.
 */
async function loadBlob(blob) {
  if (!blob) { toast('No image data provided', true); return; }
  if (blob.size > 50 * 1024 * 1024) { toast('Image too large (max 50MB)', true); return; }

  let src;
  try {
    src = await blobToSource(blob);
  } catch {
    toast('Could not read that image', true);
    return;
  }
  const w = src.width ?? src.naturalWidth;
  const h = src.height ?? src.naturalHeight;
  if (!w || !h) { toast('Not a valid image', true); return; }
  if (w > 16384 || h > 16384) { toast('Image dimensions too large (max 16384px)', true); return; }

  state.source = src;
  state.srcId++;
  state.origW = w;
  state.origH = h;
  state.fileName = (blob.name ?? 'pasted-wallpaper').replace(/\.[^.]+$/, '') || 'wallpaper';

  srcPixels = null;
  srcKey = '';
  srcBuild = null;
  srcBuildKey = '';

  updatePreviewSize();
  preview.hidden = false;
  $('#stage-empty').hidden = true;
  $('#meta-name').textContent = blob.name ?? 'clipboard image';
  $('#meta-name').title = blob.name ?? 'clipboard image';
  $('#meta-size').textContent = `${w} × ${h}`;
  render();
  setStatus('Loaded');
}

async function openFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('Please choose an image file', true); return; }
  await loadBlob(file);
}


/* ------------------------------------------------------------------ demo
   The bundled demo image: ./demo.jpg */

async function makeDemo() {
  setStatus('Loading demo image…');
  try {
    const res = await fetch('./demo.jpg');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!blob.size) throw new Error('empty');
    const f = new File([blob], "demo.jpg", { type: blob.type || "image/jpeg" });
    await loadBlob(f);

  } catch (e) {
    console.error('Could not load demo.jpg', e);
    toast('Could not load demo image', true);
  }
}


/* exact match for ImageMagick's `-colorspace Gray` */
const GRAY_COEFFS = new Float32Array([0.212656, 0.715158, 0.072186]);

function grayOf(r, g, b) {
  return (GRAY_COEFFS[0] * r + GRAY_COEFFS[1] * g + GRAY_COEFFS[2] * b) / 255;
}

/* Pre-computed Bayer 4x4 offsets */
const BAYER4_OFFSETS = (() => {
  const m = BAYER4;
  const size = 4;
  const cells = 16;
  const out = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    out[i] = ((m[i] + 0.5) / cells - 0.5);
  }
  return out;
})();

function processPixels(data, w, h, p, scratch) {
  const n = w * h;
  const buf = (scratch && scratch.length >= n) ? scratch : new Float32Array(n);

  /* Luminance (rec.709) */
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    buf[i] = grayOf(data[j], data[j + 1], data[j + 2]);
  }

  /* Levels (always applied for quantize) */
  const bp = p.black / 100;
  const wp = Math.max(p.white / 100, bp + 1e-6);
  const span = wp - bp;
  const invert = p.invert;

  for (let i = 0; i < n; i++) {
    let v = (buf[i] - bp) / span;
    if (v < 0) v = 0;
    else if (v > 1) v = 1;
    buf[i] = invert ? 1 - v : v;
  }

  /* Quantize */
  const L = Math.max(2, p.levels | 0);
  const step = 1 / (L - 1);
  const invStep = L - 1;
  const quantize = (v) => {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return Math.round(v * invStep) * step;
  };

  /* Precompute quantization LUT for fast posterize (256 entries, 0-1 -> 0-1) */
  let quantLUT = quantLUTCache.get(L);
  if (!quantLUT) {
    quantLUT = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      quantLUT[i] = v <= 0 ? 0 : v >= 1 ? 1 : Math.round(v * invStep) * step;
    }
    quantLUTCache.set(L, quantLUT);
  }
  const quantizeFast = (v) => quantLUT[v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255)];
  const spread = step;

  const dither = p.dither;
  const ditherStrength = p.ditherStrength / 100;
  if (dither === 'none') {
    for (let i = 0; i < n; i++) buf[i] = quantizeFast(buf[i]);
  } else if (DIFFUSION[dither]) {
    ditherDiffuse(buf, w, h, quantize, DIFFUSION[dither], ditherStrength);
  } else if (dither === 'noise') {
    ditherNoise(buf, n, spread, quantize, ditherStrength);
  } else if (dither === 'bayer4') {
    ditherOrdered(buf, w, h, spread, quantize, ditherStrength);
  }

  /* Map to color stops */
  const stops = getParsedStops(p.stops);
  const k = stops.length >= 2 ? stops.length : 2;
  const stopData = new Float32Array(k * 3);
  for (let i = 0; i < k; i++) {
    const rgb = stops[i] || (i === 0 ? [0, 0, 0] : [255, 255, 255]);
    stopData[i * 3] = rgb[0];
    stopData[i * 3 + 1] = rgb[1];
    stopData[i * 3 + 2] = rgb[2];
  }
  const k1 = k - 1;

  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const t = buf[i] < 0 ? 0 : buf[i] > 1 ? 1 : buf[i];
    const x = t * k1;
    const idx = x >= k1 ? k - 2 : Math.floor(x);
    const f = x - idx;
    const o = idx * 3;
    data[j] = Math.round(stopData[o] + (stopData[o + 3] - stopData[o]) * f);
    data[j + 1] = Math.round(stopData[o + 1] + (stopData[o + 4] - stopData[o + 1]) * f);
    data[j + 2] = Math.round(stopData[o + 2] + (stopData[o + 5] - stopData[o + 2]) * f);
    data[j + 3] = 255;
  }
}

function ditherDiffuse(buf, w, h, quantize, kernel, strength) {
  const { div, taps } = kernel;
  const nt = taps.length;
  const divInv = 1 / div;
  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    for (let x = 0; x < w; x++) {
      const i = rowBase + x;
      const old = buf[i];
      const nv = quantize(old);
      buf[i] = nv;
      const err = (old - nv) * divInv * strength;
      if (err === 0) continue;
      for (let t = 0; t < nt; t++) {
        const nx = x + taps[t][0];
        const ny = y + taps[t][1];
        if (nx >= 0 && nx < w && ny < h) buf[ny * w + nx] += err * taps[t][2];
      }
    }
  }
}

function ditherOrdered(buf, w, h, spread, quantize, strength) {
  const size = 4;
  const cells = 16;
  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    const yMod = y & 3;
    for (let x = 0; x < w; x++) {
      const i = rowBase + x;
      const xMod = x & 3;
      const offset = BAYER4_OFFSETS[yMod * size + xMod] * spread * strength;
      const v = buf[i] + offset;
      buf[i] = quantize(v < 0 ? 0 : v > 1 ? 1 : v);
    }
  }
}

function ditherNoise(buf, n, spread, quantize, strength) {
  const halfSpread = spread * 0.5;
  for (let i = 0; i < n; i++) {
    const v = buf[i] + (Math.random() - 0.5) * spread * strength;
    buf[i] = quantize(v < 0 ? 0 : v > 1 ? 1 : v);
  }
}

/* ---------------------------------------------------------------- render
   The source is downscaled once per (image, preview size) into a reusable
   ImageData; every parameter change then only pays a memcpy + pipeline pass
   instead of a canvas readback. The resize uses createImageBitmap's high
   quality filter, so preview quality goes up, not down. */

function ensureWork() {
  if (!work || work.width !== state.previewW || work.height !== state.previewH) {
    work = new ImageData(state.previewW, state.previewH);
  }
  return work;
}

/* scratch gray-buffer, reused for the preview size */
let pbuf = new Float32Array(0);
let pbufKey = '';
function previewBuf(n) {
  const key = `${state.previewW}x${state.previewH}`;
  if (pbufKey !== key || pbuf.length < n) {
    pbuf = new Float32Array(n);
    pbufKey = key;
  }
  return pbuf;
}

/* scratch gray-buffer for full-size export */
let fbuf = new Float32Array(0);
let fbufKey = '';
function fullBuf(n, w, h) {
  const key = `${w}x${h}`;
  if (fbufKey !== key || fbuf.length < n) {
    fbuf = new Float32Array(n);
    fbufKey = key;
  }
  return fbuf;
}

async function buildPreviewPixels(srcId, w, h) {
  let draw = state.source;
  let owned = false;
  if (w !== state.origW || h !== state.origH) {
    try {
      draw = await createImageBitmap(state.source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      owned = true;
    } catch { draw = state.source; }
  }
  const stale = srcId !== state.srcId || w !== state.previewW || h !== state.previewH;
  if (stale) { if (owned && draw.close) draw.close(); return null; }

  srcCanvas.width = w;
  srcCanvas.height = h;
  srcCtx.drawImage(draw, 0, 0, w, h);
  if (owned && draw.close) draw.close();
  return srcCtx.getImageData(0, 0, w, h);
}

function ensurePreviewPixels() {
  const srcId = state.srcId;
  const w = state.previewW;
  const h = state.previewH;
  const key = `${srcId}|${w}x${h}`;
  if (srcPixels && srcKey === key) return Promise.resolve(srcPixels);
  if (srcBuild && srcBuildKey === key) return srcBuild;

  srcBuildKey = key;
  srcBuild = buildPreviewPixels(srcId, w, h)
    .then((px) => {
      if (px) { srcPixels = px; srcKey = key; }
      return px;
    })
    .catch(() => null)
    .finally(() => { if (srcBuildKey === key) srcBuild = null; });
  return srcBuild;
}

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

/**
 * Renders the preview with current parameters.
 * Uses a token system to handle race conditions from rapid parameter changes.
 */
async function render() {
  if (!state.source) return;
  const token = ++renderToken;
  const currentSource = state.source;
  const t0 = performance.now();
  try {
    const src = await ensurePreviewPixels();
    if (!src || token !== renderToken || state.source !== currentSource) return;
    ensureWork();

    if (state.compare) {
      pctx.putImageData(src, 0, 0);
      setStatus('Original');
      return;
    }

    work.data.set(src.data);
    processPixels(work.data, state.previewW, state.previewH, state.params, previewBuf(state.previewW * state.previewH));
    pctx.putImageData(work, 0, 0);
    setStatus(`${state.previewW} × ${state.previewH} · ${(performance.now() - t0).toFixed(1)} ms`);
  } catch (err) {
    console.error('Render error:', err);
    setStatus('Render error');
  }
}

/**
 * Renders the image at full resolution for export.
 * @returns {Promise<HTMLCanvasElement>} The rendered canvas.
 */
async function renderFull() {
  const c = document.createElement('canvas');
  c.width = state.origW;
  c.height = state.origH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  try {
    ctx.drawImage(state.source, 0, 0, state.origW, state.origH);
    const img = ctx.getImageData(0, 0, state.origW, state.origH);
    processPixels(img.data, state.origW, state.origH, state.params, fullBuf(state.origW * state.origH, state.origW, state.origH));
    ctx.putImageData(img, 0, 0);
    return c;
  } catch (e) {
    c.width = 1; c.height = 1; // Allow GC
    throw e;
  }
}

/* ---------------------------------------------------------------- export */

async function withFullRender(fn) {
  if (!state.source) { toast('Load an image first', true); return; }
  if (exportBusy) return;
  exportBusy = true;
  setStatus('Rendering full size…');
  await new Promise((r) => setTimeout(r, 16));
  try {
    const canvas = await renderFull();
    await fn(canvas);
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + e.message, true);
  } finally {
    exportBusy = false;
    render();
  }
}

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type));
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function download() {
  await withFullRender(async (canvas) => {
    const blob = await canvasToBlob(canvas);
    const name = `${state.fileName}-waltil.png`;
    triggerDownload(blob, name);
    toast(`Saved ${name} (${state.origW}×${state.origH})`);
  });
}

async function copyToClipboard() {
  if (!window.ClipboardItem || !navigator.clipboard?.write) {
    toast('Clipboard image copy is not supported here — use Download', true);
    return;
  }
  await withFullRender(async (canvas) => {
    const blob = await canvasToBlob(canvas);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Full-size PNG copied to clipboard');
  });
}

/* ------------------------------------------------------------ pan & zoom
   The canvas keeps its centered flexbox fit and gets a transform on top:
   wheel zoom anchored at the cursor, drag to pan, pinch on touch. */

function applyView() {
  preview.style.transform = (view.z === 1 && view.x === 0 && view.y === 0)
    ? ''
    : `translate(${view.x.toFixed(2)}px, ${view.y.toFixed(2)}px) scale(${view.z})`;
  preview.classList.toggle('zoomed', view.z > 1.5);
  $('#zoom-level').textContent = Math.round(view.z * 100) + '%';
}

function clampView() {
  const bw = preview.offsetWidth;
  const bh = preview.offsetHeight;
  if (!bw || !bh) return;
  const wr = wrap.getBoundingClientRect();
  const overX = Math.max(0, (bw * view.z - wr.width) / 2);
  const overY = Math.max(0, (bh * view.z - wr.height) / 2);
  view.x = clamp(view.x, -overX, overX);
  view.y = clamp(view.y, -overY, overY);
}

function resetView() {
  view.z = 1;
  view.x = 0;
  view.y = 0;
  applyView();
}

function zoomAt(factor, cx, cy) {
  if (!state.source) return;
  const z0 = view.z;
  const z1 = clamp(z0 * factor, 1, 24);
  if (z1 === z0) return;
  const wr = wrap.getBoundingClientRect();
  const tx = cx - wr.left - wr.width / 2;
  const ty = cy - wr.top - wr.height / 2;
  const bx = (tx - view.x) / z0;
  const by = (ty - view.y) / z0;
  view.z = z1;
  view.x = tx - bx * z1;
  view.y = ty - by * z1;
  clampView();
  applyView();
}

function bindView() {
  wrap.addEventListener('wheel', (e) => {
    if (!state.source) return;
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });

  const ptrs = new Map();

  wrap.addEventListener('pointerdown', (e) => {
    if (!state.source) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { wrap.setPointerCapture(e.pointerId); } catch { /* capture is best effort */ }
    wrap.classList.add('grabbing');
  });

  wrap.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;

    if (ptrs.size === 2) {
      let other = null;
      for (const [id, pt] of ptrs) if (id !== e.pointerId) other = pt;
      if (!other) return;
      const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
      const prevMidX = (prev.x + other.x) / 2;
      const prevMidY = (prev.y + other.y) / 2;
      const cur = { x: e.clientX, y: e.clientY };
      ptrs.set(e.pointerId, cur);
      const dist = Math.hypot(cur.x - other.x, cur.y - other.y);
      const midX = (cur.x + other.x) / 2;
      const midY = (cur.y + other.y) / 2;
      view.x += midX - prevMidX;
      view.y += midY - prevMidY;
      if (prevDist > 1) zoomAt(dist / prevDist, midX, midY);
      clampView();
      applyView();
      return;
    }

    view.x += e.clientX - prev.x;
    view.y += e.clientY - prev.y;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clampView();
    applyView();
  });

  const endPointer = (e) => {
    ptrs.delete(e.pointerId);
    if (!ptrs.size) wrap.classList.remove('grabbing');
  };
  wrap.addEventListener('pointerup', endPointer);
  wrap.addEventListener('pointercancel', endPointer);

  wrap.addEventListener('dblclick', () => { if (state.source) resetView(); });

  const zoomTo = (factor) => {
    const r = wrap.getBoundingClientRect();
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  };
  $('#btn-zoom-in').addEventListener('click', () => zoomTo(1.4));
  $('#btn-zoom-out').addEventListener('click', () => zoomTo(1 / 1.4));
  $('#zoom-level').addEventListener('click', () => { if (state.source) resetView(); });

  window.addEventListener('resize', () => {
    if (!state.source) return;
    clampView();
    applyView();
  });
}

/* ---------------------------------------------------------------- UI */

/* reordering stops with pointer drag: works with mouse and touch, and uses
   the same pointer-capture machinery as the stage pan */
let stopDrag = null;

function clearDropHints() {
  document.querySelectorAll('.stop.drop-before, .stop.drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

function stopPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('input, button')) return;
  const row = e.currentTarget;
  stopDrag = {
    from: Number(row.dataset.idx),
    row,
    id: e.pointerId,
    x0: e.clientX,
    y0: e.clientY,
    active: false,
    to: null,
    after: false,
  };
  try { row.setPointerCapture(e.pointerId); } catch { /* capture is best effort */ }
}

function stopPointerMove(e) {
  const d = stopDrag;
  if (!d || e.pointerId !== d.id) return;
  if (!d.active) {
    if (Math.abs(e.clientX - d.x0) < 4 && Math.abs(e.clientY - d.y0) < 4) return;
    d.active = true;
    d.row.classList.add('dragging');
  }
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const target = el && el.closest ? el.closest('.stop') : null;
  clearDropHints();
  d.to = null;
  if (!target) return;
  const to = Number(target.dataset.idx);
  if (to === d.from) return;
  const r = target.getBoundingClientRect();
  d.after = e.clientY > r.top + r.height / 2;
  d.to = to;
  target.classList.add(d.after ? 'drop-after' : 'drop-before');
}

function stopPointerEnd(e) {
  const d = stopDrag;
  if (!d || e.pointerId !== d.id) return;
  stopDrag = null;
  clearDropHints();
  d.row.classList.remove('dragging');
  if (d.active && d.to !== null) reorderStops(d.from, d.to, d.after);
}

function moveStop(from, to, after) {
  const stops = state.params.stops;
  if (from === to && !after) return false;
  if (from < 0 || from >= stops.length) return false;
  let pos = clamp(to + (after ? 1 : 0), 0, stops.length);
  const [moved] = stops.splice(from, 1);
  if (from < pos) pos--;
  stops.splice(clamp(pos, 0, stops.length), 0, moved);
  return true;
}

function reorderStops(from, to, after) {
  if (!moveStop(from, to, after)) return;
  markCustom();
  renderStops();
  touch();
}

function renderStops() {
  const wrapEl = $('#stops');
  wrapEl.innerHTML = '';
  const stops = state.params.stops;

  stops.forEach((hex, i) => {
    const row = document.createElement('div');
    row.className = 'stop';
    row.dataset.idx = String(i);

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.title = 'Drag to reorder';
    grip.setAttribute('aria-hidden', 'true');

    const color = document.createElement('input');
    color.type = 'color';
    color.value = parseHex(hex) ? hex.toUpperCase() : '#000000';
    color.title = 'Pick color ' + (i + 1);
    color.setAttribute('aria-label', 'Color ' + (i + 1));

    const text = document.createElement('input');
    text.type = 'text';
    text.value = hex.toUpperCase();
    text.spellcheck = false;
    text.placeholder = '#RRGGBB';
    text.pattern = '#[0-9a-fA-F]{6}';
    text.setAttribute('aria-label', 'Hex color ' + (i + 1));

    const sync = (val, from) => {
      const rgb = parseHex(val);
      if (!rgb) { text.setCustomValidity('Invalid hex color'); return; }
      text.setCustomValidity('');
      state.params.stops[i] = toHex(rgb);
      if (from !== 'text') text.value = state.params.stops[i];
      if (from !== 'color') color.value = state.params.stops[i];
      markCustom();
      touch();
    };

    color.addEventListener('input', () => sync(color.value, 'color'));
    text.addEventListener('input', () => sync(text.value, 'text'));
    text.addEventListener('blur', () => {
      const rgb = parseHex(text.value);
      text.setCustomValidity('');
      text.value = (rgb ? toHex(rgb) : state.params.stops[i]).toUpperCase();
    });

    row.append(grip, color, text);

    /* drag to reorder: grip marks the affordance, the whole row drags */
    row.addEventListener('pointerdown', stopPointerDown);
    row.addEventListener('pointermove', stopPointerMove);
    row.addEventListener('pointerup', stopPointerEnd);
    row.addEventListener('pointercancel', stopPointerEnd);

    if (stops.length > 2) {
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Remove color';
      rm.setAttribute('aria-label', 'Remove color ' + (i + 1));
      rm.addEventListener('click', () => {
        state.params.stops.splice(i, 1);
        markCustom();
        renderStops();
        touch();
      });
      row.appendChild(rm);
    }

    wrapEl.appendChild(row);
  });

  $('#btn-add-stop').disabled = state.params.stops.length >= 8;
}

function setPairValue(id, value) {
  $('#' + id).value = value;
  $('#' + id + '-num').value = fmtNum(id, value);
}

function syncControls() {
  const p = state.params;
  setPairValue('black', p.black);
  setPairValue('white', p.white);
  setPairValue('levels', p.levels);
  setPairValue('dither-strength', p.ditherStrength);
  $('#invert').checked = p.invert;
  $('#dither').value = p.dither;
  updateDitherStrengthState();
  updateQualityOptions();
  // Update custom select
  const presetVal = p.preset;
  $('#preset').value = presetVal;
  const triggerSwatches = $('#preset-trigger-swatches');
  const triggerText = $('#preset-trigger-text');
  const options = $('#preset-options').querySelectorAll('.custom-select-option');
  // Clear all first
  options.forEach(o => o.setAttribute('aria-selected', 'false'));
  // Set correct one
  options.forEach(o => {
    const selected = o.dataset.value === presetVal;
    if (selected) {
      o.setAttribute('aria-selected', 'true');
      triggerText.textContent = o.textContent.trim();
      triggerSwatches.innerHTML = '';
      const colors = presetVal && o.dataset.colors
        ? o.dataset.colors.split(',')
        : p.stops;
      colors.forEach(c => {
        const s = document.createElement('span');
        s.style.background = c.trim();
        triggerSwatches.appendChild(s);
      });
    }
  });
  renderStops();
}

/* range + typed number box for the same value */
function bindPair(id, key) {
  const range = $('#' + id);
  const num = $('#' + id + '-num');
  const def = NUMS[key];

  range.addEventListener('input', () => {
    const v = Number(range.value);
    state.params[key] = v;
    num.value = fmtNum(key, v);
    touch();
  });

  num.addEventListener('input', () => {
    if (num.value === '' || num.value === '-') return;
    const v = Number(num.value);
    if (!Number.isFinite(v) || v < def.min || v > def.max) return;
    state.params[key] = def.digits === 0 ? Math.round(v) : v;
    range.value = state.params[key];
    touch();
  });

  const normalize = () => {
    let v = Number(num.value);
    if (!Number.isFinite(v)) v = state.params[key];
    v = clampNum(v, key);
    state.params[key] = v;
    range.value = v;
    num.value = fmtNum(key, v);
    touch();
  };
  num.addEventListener('change', normalize);
  num.addEventListener('blur', normalize);
}

function applyDefaults() {
  state.params = freshParams();
  syncControls();
  if (state.source) updatePreviewSize();
  applyAccent();
  saveSettingsNow();
  if (state.source) {
    render().catch((err) => {
      console.error('Render failed after reset:', err);
      toast('Failed to reset preview', true);
    });
  }
}

const SECTION_RESETS = {
  source: (p) => { p.previewQuality = DEFAULTS.previewQuality; },
  colors: (p) => { p.stops = PRESETS.mono.slice(); p.preset = 'mono'; },
  quantize: (p) => {
    p.levels = 4;
    p.black = 0;
    p.white = 100;
    p.invert = false;
    p.dither = 'none';
    p.ditherStrength = 100;
  },
};

function clearSource() {
  if (state.source && state.source.close) {
    state.source.close();
  }
  state.source = null;
  state.srcId++;
  state.origW = 0;
  state.origH = 0;
  state.fileName = 'wallpaper';
  state.previewW = 0;
  state.previewH = 0;
  preview.width = 1;
  preview.height = 1;
  preview.hidden = true;
  $('#stage-empty').hidden = false;
  $('#meta-name').textContent = '—';
  $('#meta-size').textContent = '—';
  $('#meta-preview').textContent = '—';
  srcPixels = null;
  srcKey = '';
  srcBuild = null;
  srcBuildKey = '';
  work = null;
}

function resetSection(name) {
  const fn = SECTION_RESETS[name];
  if (!fn) return;
  fn(state.params);
  if (name === 'source') clearSource();
  syncControls();
  if (name === 'source' && state.source) updatePreviewSize();
  touch();
  toast('Reset');
}

function bindUI() {
  $('#btn-open').addEventListener('click', () => $('#file-input').click());
  $('#btn-open-2').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    openFile(e.target.files?.[0]);
    e.target.value = '';
  });

  $('#btn-demo').addEventListener('click', makeDemo);
  $('#btn-demo-2').addEventListener('click', makeDemo);

  $('#btn-paste').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.read) {
        toast('Clipboard API not available — press Ctrl+V to paste');
        return;
      }
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          await loadBlob(blob);
          return;
        }
      }
      toast('No image found in the clipboard');
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        toast('Clipboard access denied — press Ctrl+V to paste');
      } else {
        console.error('Paste error:', err);
        toast('Failed to paste from clipboard');
      }
    }
  });

  $('#btn-download-2').addEventListener('click', download);
  $('#btn-copy-2').addEventListener('click', copyToClipboard);

  $('#btn-reset').addEventListener('click', () => { applyDefaults(); toast('Settings reset'); });
  document.querySelectorAll('[data-reset]').forEach((el) => {
    el.addEventListener('click', () => resetSection(el.dataset.reset));
  });

  bindPair('black', 'black');
  bindPair('white', 'white');
  bindPair('levels', 'levels');
  bindPair('dither-strength', 'ditherStrength');

  updateDitherStrengthState();
  $('#dither').addEventListener('change', (e) => {
    state.params.dither = e.target.value;
    updateDitherStrengthState();
    touch();
  });
  $('#invert').addEventListener('change', (e) => { state.params.invert = e.target.checked; touch(); });

  $('#preview-quality').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!PREVIEW_QUALITIES.includes(v)) return;
    state.params.previewQuality = v;
    if (state.source) updatePreviewSize();
    touch();
  });

  $('#preset').addEventListener('change', (e) => {
    const colors = PRESETS[e.target.value];
    if (!colors) { state.params.preset = ''; touch(); return; }
    state.params.stops = colors.slice();
    state.params.preset = e.target.value;
    renderStops();
    touch();
  });

  // Custom select dropdown for palettes
  (() => {
    const wrap = $('#preset-wrap');
    const trigger = $('#preset-trigger');
    const optionsList = $('#preset-options');
    const hiddenInput = $('#preset');
    const triggerSwatches = $('#preset-trigger-swatches');
    const triggerText = $('#preset-trigger-text');
    const options = optionsList.querySelectorAll('.custom-select-option');
    let open = false;

    function close() {
      optionsList.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      open = false;
    }

    function openDropdown() {
      optionsList.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      open = true;
    }

    function selectOption(option) {
      const value = option.dataset.value;
      const colors = option.dataset.colors;
      const text = option.textContent.trim();

      hiddenInput.value = value;
      state.params.preset = value;
      if (colors) {
        state.params.stops = colors.split(',').map(c => c.trim().toUpperCase());
      } else {
        state.params.preset = '';
      }

      // Update trigger
      triggerText.textContent = text;
      triggerSwatches.innerHTML = '';
      if (colors) {
        colors.split(',').forEach(c => {
          const s = document.createElement('span');
          s.style.background = c.trim();
          triggerSwatches.appendChild(s);
        });
      }

      // Update aria-selected
      options.forEach(o => o.setAttribute('aria-selected', 'false'));
      option.setAttribute('aria-selected', 'true');

      renderStops();
      touch();
      close();
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      open ? close() : openDropdown();
    });

    optionsList.addEventListener('click', (e) => {
      const option = e.target.closest('.custom-select-option');
      if (option) selectOption(option);
    });

    optionsList.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); trigger.focus(); }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const selected = optionsList.querySelector('[aria-selected="true"]');
        const idx = Array.from(options).indexOf(selected);
        const next = options[(idx + 1) % options.length];
        next.focus();
        next.setAttribute('aria-selected', 'true');
        if (selected) selected.setAttribute('aria-selected', 'false');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const selected = optionsList.querySelector('[aria-selected="true"]');
        const idx = Array.from(options).indexOf(selected);
        const prev = options[(idx - 1 + options.length) % options.length];
        prev.focus();
        prev.setAttribute('aria-selected', 'true');
        if (selected) selected.setAttribute('aria-selected', 'false');
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const focused = optionsList.querySelector(':focus');
        if (focused) selectOption(focused);
      }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (open && !wrap.contains(e.target)) close();
    });

    // Initialize trigger swatches from loaded settings (state.params already loaded)
    function setupTrigger(option, colors) {
      triggerText.textContent = option ? option.textContent.trim() : 'Custom';
      triggerSwatches.innerHTML = '';
      if (colors) {
        colors.split(',').forEach(c => {
          const s = document.createElement('span');
          s.style.background = c.trim();
          triggerSwatches.appendChild(s);
        });
      }
      options.forEach(o => o.setAttribute('aria-selected', 'false'));
      if (option) option.setAttribute('aria-selected', 'true');
    }

    const presetVal = state.params.preset;
    let initialOpt = null;
    if (presetVal) {
      initialOpt = optionsList.querySelector(`[data-value="${presetVal}"]`);
    } else {
      initialOpt = optionsList.querySelector('[data-value=""]');
    }
    if (!initialOpt) {
      setupTrigger(null, state.params.stops.join(','));
    } else if (initialOpt.dataset.colors) {
      setupTrigger(initialOpt, initialOpt.dataset.colors);
    } else {
      setupTrigger(initialOpt, state.params.stops.join(','));
    }
    renderStops();
  })();

  $('#btn-add-stop').addEventListener('click', () => {
    if (state.params.stops.length >= 8) return;
    const last = parseHex(state.params.stops[state.params.stops.length - 1]) || [128, 128, 128];
    state.params.stops.push(toHex(last));
    markCustom();
    renderStops();
    touch();
  });

  $('#btn-save-palette').addEventListener('click', () => {
    const data = JSON.stringify({ stops: state.params.stops }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'palette.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Palette saved');
  });

  $('#btn-load-palette').addEventListener('click', () => {
    $('#palette-file-input').click();
  });

  $('#palette-file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.stops && Array.isArray(data.stops) && data.stops.length >= 2) {
          const stops = data.stops.slice(0, 8).map(parseHex).filter(Boolean).map(toHex);
          if (stops.length >= 2) {
            state.params.stops = stops;
            state.params.preset = '';
            renderStops();
            touch();
            toast('Palette loaded');
          } else {
            toast('Invalid palette: need at least 2 valid colors', true);
          }
        } else {
          toast('Invalid palette format', true);
        }
      } catch {
        toast('Failed to parse JSON', true);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* compare: hold */
  const cmp = $('#btn-compare');
  const setCompare = (on) => {
    if (state.compare === on) return;
    state.compare = on;
    if (state.source) render();
  };
  cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); cmp.setPointerCapture(e.pointerId); setCompare(true); });
  cmp.addEventListener('pointerup', () => setCompare(false));
  cmp.addEventListener('pointercancel', () => setCompare(false));
  cmp.addEventListener('pointerleave', () => setCompare(false));

  /* paste anywhere */
  window.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        e.preventDefault();
        openFile(item.getAsFile());
        return;
      }
    }
  });

  /* drag & drop */
  const stage = $('#stage');
  const showDrag = (on) => {
    stage.classList.toggle('dragover', on);
    document.body.classList.toggle('dragging', on);
  };
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!e.dataTransfer?.types.includes('Files')) return;
    showDrag(true);
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (e.clientX === 0 && e.clientY === 0) return; // Ignore synthetic events
    const rect = stage.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      showDrag(false);
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    showDrag(false);
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) openFile(file);
    else toast('Drop an image file', true);
  });

  bindView();
}

loadSettings();
bindUI();
applyAccent();
syncControls();
applyView();
setStatus('Ready — open, paste or drop an image');
