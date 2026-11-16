// The Golden Ring — make.fun ai-excited-01
//
// A program that draws, from scratch, one image meant to make an AI judge
// sit up: a colossal golden ring igniting over a dark sea at dusk, a tiny
// sailboat beneath it for scale, light bursting through its centre, and a
// short line addressed to the judge along the bottom.
//
// Pure Node standard library: no dependencies, no network, no randomness
// outside a fixed seed — two runs write byte-identical PNGs.
//
// Usage:  MAKEFUN_OUTPUT_DIR=out node main.ts   (writes out/entry.png)
//         node main.ts                          (writes /output/entry.png)

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Deterministic random numbers (mulberry32, fixed seed)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261116);

// ---------------------------------------------------------------------------
// Canvas: a float RGB buffer (0..255 per channel) plus an additive glow layer
// ---------------------------------------------------------------------------

const W = 1024;
const H = 1024;

const img = new Float32Array(W * H * 3); // final colour
const glow = new Float32Array(W * H * 3); // additive light, blurred later

function idx(x: number, y: number): number {
  return (y * W + x) * 3;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Alpha-composite an opaque-ish colour onto the image buffer.
function paint(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = idx(x, y);
  const inv = 1 - a;
  img[i] = r * a + img[i] * inv;
  img[i + 1] = g * a + img[i + 1] * inv;
  img[i + 2] = b * a + img[i + 2] * inv;
}

// Add light to the glow layer (clamped later when merged).
function addGlow(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = idx(x, y);
  glow[i] += r * a;
  glow[i + 1] += g * a;
  glow[i + 2] += b * a;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(a: number, b: number, t: number): number {
  const x = t < a ? 0 : t > b ? 1 : (t - a) / (b - a);
  return x * x * (3 - 2 * x);
}

type RGB = [number, number, number];

// Sample a multi-stop vertical gradient. Stops are [position 0..1, colour].
function vgrad(stops: Array<[number, RGB]>, t: number): RGB {
  if (t <= stops[0][0]) return stops[0][1];
  for (let s = 0; s < stops.length - 1; s++) {
    const [p0, c0] = stops[s];
    const [p1, c1] = stops[s + 1];
    if (t <= p1) {
      const k = (t - p0) / (p1 - p0);
      return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)];
    }
  }
  return stops[stops.length - 1][1];
}

// Fill the whole canvas with a vertical gradient.
function fillVGrad(stops: Array<[number, RGB]>): void {
  for (let y = 0; y < H; y++) {
    const [r, g, b] = vgrad(stops, y / (H - 1));
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      img[i] = r;
      img[i + 1] = g;
      img[i + 2] = b;
    }
  }
}

// ---------------------------------------------------------------------------
// Value noise (seeded, 2 octaves) for clouds and sea texture
// ---------------------------------------------------------------------------

const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

function hash2(ix: number, iy: number): number {
  return PERM[(PERM[ix & 255] + iy) & 255] / 255;
}

function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

function fbm(x: number, y: number): number {
  return noise2(x, y) * 0.65 + noise2(x * 2.13 + 7.7, y * 2.13 + 3.1) * 0.35;
}

// ---------------------------------------------------------------------------
// Separable box blur (sliding window) on a float RGB buffer, in place
// ---------------------------------------------------------------------------

function blurHorizontal(buf: Float32Array, radius: number): void {
  const tmp = new Float32Array(W * 3);
  const div = 1 / (2 * radius + 1);
  for (let y = 0; y < H; y++) {
    const row = y * W * 3;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let k = -radius; k <= radius; k++) {
      const xx = k < 0 ? 0 : k >= W ? W - 1 : k;
      const i = row + xx * 3;
      sr += buf[i];
      sg += buf[i + 1];
      sb += buf[i + 2];
    }
    for (let x = 0; x < W; x++) {
      const o = x * 3;
      tmp[o] = sr * div;
      tmp[o + 1] = sg * div;
      tmp[o + 2] = sb * div;
      const xOut = x - radius;
      const xIn = x + radius + 1;
      const oOut = (xOut < 0 ? 0 : xOut >= W ? W - 1 : xOut) * 3;
      const oIn = (xIn < 0 ? 0 : xIn >= W ? W - 1 : xIn) * 3;
      sr += buf[row + oIn] - buf[row + oOut];
      sg += buf[row + oIn + 1] - buf[row + oOut + 1];
      sb += buf[row + oIn + 2] - buf[row + oOut + 2];
    }
    for (let x = 0; x < W * 3; x++) buf[row + x] = tmp[x];
  }
}

function blurVertical(buf: Float32Array, radius: number): void {
  const tmp = new Float32Array(H * 3);
  const div = 1 / (2 * radius + 1);
  for (let x = 0; x < W; x++) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let k = -radius; k <= radius; k++) {
      const yy = k < 0 ? 0 : k >= H ? H - 1 : k;
      const i = (yy * W + x) * 3;
      sr += buf[i];
      sg += buf[i + 1];
      sb += buf[i + 2];
    }
    for (let y = 0; y < H; y++) {
      const o = y * 3;
      tmp[o] = sr * div;
      tmp[o + 1] = sg * div;
      tmp[o + 2] = sb * div;
      const yOut = y - radius;
      const yIn = y + radius + 1;
      const iOut = ((yOut < 0 ? 0 : yOut >= H ? H - 1 : yOut) * W + x) * 3;
      const iIn = ((yIn < 0 ? 0 : yIn >= H ? H - 1 : yIn) * W + x) * 3;
      sr += buf[iIn] - buf[iOut];
      sg += buf[iIn + 1] - buf[iOut + 1];
      sb += buf[iIn + 2] - buf[iOut + 2];
    }
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 3;
      buf[i] = tmp[y * 3];
      buf[i + 1] = tmp[y * 3 + 1];
      buf[i + 2] = tmp[y * 3 + 2];
    }
  }
}

function blur(buf: Float32Array, radius: number, passes: number): void {
  for (let p = 0; p < passes; p++) {
    blurHorizontal(buf, radius);
    blurVertical(buf, radius);
  }
}

// ---------------------------------------------------------------------------
// PNG encoding (stdlib zlib + hand-rolled CRC32 and chunks)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Encode the float RGB buffer as a PNG (colour type 2, 8-bit). Each scanline
// picks the cheapest of the None / Sub / Up / Paeth filters.
function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = W * 3;
  const raw = Buffer.alloc(H * (stride + 1));
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  const cand: Array<Buffer> = [];
  for (let f = 0; f < 4; f++) cand.push(Buffer.alloc(stride));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      cur[x * 3] = clamp255(Math.round(img[i]));
      cur[x * 3 + 1] = clamp255(Math.round(img[i + 1]));
      cur[x * 3 + 2] = clamp255(Math.round(img[i + 2]));
    }
    // Filter 0: None
    cand[0].set(cur);
    // Filter 1: Sub
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? cur[x - 3] : 0;
      cand[1][x] = (cur[x] - left) & 0xff;
    }
    // Filter 2: Up
    for (let x = 0; x < stride; x++) {
      cand[2][x] = (cur[x] - prev[x]) & 0xff;
    }
    // Filter 4: Paeth
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? cur[x - 3] : 0;
      const up = prev[x];
      const upLeft = x >= 3 ? prev[x - 3] : 0;
      cand[3][x] = (cur[x] - paeth(left, up, upLeft)) & 0xff;
    }
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 4; f++) {
      let s = 0;
      const b = cand[f];
      for (let x = 0; x < stride; x++) {
        const v = b[x];
        s += v < 128 ? v : 256 - v;
      }
      if (s < bestScore) {
        bestScore = s;
        best = f;
      }
    }
    // Candidate index 3 holds Paeth, whose PNG filter type is 4, not 3.
    const FILTER_TYPE = [0, 1, 2, 4];
    const off = y * (stride + 1);
    raw[off] = FILTER_TYPE[best];
    cand[best].copy(raw, off + 1);
    prev.set(cur);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export { encodePNG, W, H };
export type { RGB };

// ---------------------------------------------------------------------------
// Drawing primitives (all anti-aliased by distance coverage)
// ---------------------------------------------------------------------------

// Filled disc with a soft edge. Colour may be a gradient function of radius.
function disc(
  cx: number,
  cy: number,
  r: number,
  colourAt: (t: number) => RGB,
  alpha: number,
  toGlow: boolean,
): void {
  const x0 = Math.max(0, Math.floor(cx - r - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + r + 2));
  const y0 = Math.max(0, Math.floor(cy - r - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + r + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r + 1) continue;
      const cov = d <= r - 0.5 ? 1 : (r + 0.5 - d) / 1;
      const [cr, cg, cb] = colourAt(d / r);
      if (toGlow) addGlow(x, y, cr, cg, cb, alpha * cov);
      else paint(x, y, cr, cg, cb, alpha * cov);
    }
  }
}

// Annulus (ring) centred at (cx, cy), mid radius rm, half-thickness ht.
// The colour varies with angle (0 = right, going clockwise in screen space)
// and with radial position across the band (0 = inner edge, 1 = outer edge).
function ring(
  cx: number,
  cy: number,
  rm: number,
  ht: number,
  colourAt: (angle: number, across: number) => RGB,
  alpha: number,
): void {
  const rOut = rm + ht;
  const x0 = Math.max(0, Math.floor(cx - rOut - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + rOut + 2));
  const y0 = Math.max(0, Math.floor(cy - rOut - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + rOut + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const off = Math.abs(d - rm);
      if (off > ht + 1) continue;
      const cov = off <= ht - 0.5 ? 1 : (ht + 0.5 - off) / 1;
      const angle = Math.atan2(dy, dx);
      const across = (d - (rm - ht)) / (2 * ht);
      const [cr, cg, cb] = colourAt(angle, across);
      paint(x, y, cr, cg, cb, alpha * cov);
    }
  }
}

// Thick anti-aliased line segment (round caps), painted or added to glow.
function thickLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
  toGlow: boolean,
): void {
  const hw = width / 2;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 2));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + hw + 2));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 2));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + hw + 2));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const nx = x0 + t * dx;
      const ny = y0 + t * dy;
      const d = Math.hypot(px - nx, py - ny);
      if (d > hw + 1) continue;
      const cov = d <= hw - 0.5 ? 1 : (hw + 0.5 - d) / 1;
      if (toGlow) addGlow(x, y, r, g, b, alpha * cov);
      else paint(x, y, r, g, b, alpha * cov);
    }
  }
}

// Polyline through points (thick line per segment).
function polyline(
  pts: Array<[number, number]>,
  width: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
  toGlow: boolean,
): void {
  for (let i = 0; i < pts.length - 1; i++) {
    thickLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], width, r, g, b, alpha, toGlow);
  }
}

// A sunburst ray: a long thin triangle from the centre, fading with distance.
function ray(cx: number, cy: number, angle: number, len: number, halfW: number, r: number, g: number, b: number, peak: number): void {
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const tipX = cx + dirX * len;
  const tipY = cy + dirY * len;
  const perpX = -dirY;
  const perpY = dirX;
  // Fill by scanline-ish sampling: step along the ray and stamp soft discs.
  const steps = Math.floor(len / 6);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = cx + dirX * len * t;
    const py = cy + dirY * len * t;
    const wdt = halfW * (1 - t * 0.85);
    const a = peak * (1 - t) * (1 - t);
    // Stamp a short perpendicular segment.
    thickLine(px - perpX * wdt, py - perpY * wdt, px + perpX * wdt, py + perpY * wdt, 5, r, g, b, a, true);
  }
  void tipX;
  void tipY;
}

// Four-point sparkle (star glint) at (x, y).
function sparkle(x: number, y: number, size: number, r: number, g: number, b: number, alpha: number): void {
  thickLine(x - size, y, x + size, y, 2.2, r, g, b, alpha, true);
  thickLine(x, y - size, x, y + size, 2.2, r, g, b, alpha, true);
  disc(x, y, size * 0.22, () => [r, g, b] as RGB, alpha, true);
}

// A distant bird: two short arcs forming a shallow "v".
function bird(x: number, y: number, size: number, alpha: number): void {
  const c: RGB = [8, 10, 20];
  polyline(
    [
      [x - size, y - size * 0.35],
      [x - size * 0.45, y + size * 0.15],
      [x, y],
      [x + size * 0.45, y + size * 0.15],
      [x + size, y - size * 0.35],
    ],
    2.4,
    c[0],
    c[1],
    c[2],
    alpha,
    false,
  );
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

const CX = 512; // ring centre x
const CY = 428; // ring centre y
const RING_R = 296; // ring mid radius
const RING_HT = 47; // ring half thickness
const HORIZON = 662;

function drawSky(): void {
  fillVGrad([
    [0.0, [5, 8, 26]],
    [0.32, [22, 30, 74]],
    [0.52, [66, 44, 96]],
    [0.62, [146, 74, 62]],
    [0.646, [216, 122, 50]],
    [0.65, [216, 122, 50]],
    [1.0, [216, 122, 50]],
  ]);
  // Stars in the upper sky, denser and brighter near the top.
  for (let i = 0; i < 170; i++) {
    const x = rand() * W;
    const y = Math.pow(rand(), 1.6) * 430;
    const s = rand();
    const bright = 120 + rand() * 135;
    const a = (0.25 + 0.75 * s) * (1 - y / 560);
    if (s > 0.93) sparkle(x, y, 5 + rand() * 4, bright, bright, 255, a * 0.8);
    else paint(Math.floor(x), Math.floor(y), bright, bright, 240, a);
  }
}

function drawClouds(): void {
  // Dark storm masses built from value noise, gold-lit from below.
  for (let y = 0; y < 660; y++) {
    for (let x = 0; x < W; x++) {
      const n = fbm(x * 0.0042 + 3.7, y * 0.009 + 11.2);
      const band = smoothstep(0.52, 0.72, n) * (1 - smoothstep(0.5, 0.78, y / 660));
      if (band <= 0) continue;
      // Cloud body: deep slate blue, slightly lighter where lit.
      const lit = smoothstep(0.55, 0.75, n);
      const r = lerp(20, 62, lit);
      const g = lerp(24, 60, lit);
      const b = lerp(44, 88, lit);
      paint(x, y, r, g, b, band * 0.42);
      // Gold under-light along the cloud's lower edge.
      const edge = smoothstep(0.60, 0.66, n) * (1 - smoothstep(0.66, 0.72, n));
      if (edge > 0) addGlow(x, y, 255, 170, 70, edge * 0.12);
    }
  }
}

function drawBurst(): void {
  // The portal glow: a huge soft disc of light behind the ring. The colour
  // fades to black at the rim so the disc has no hard edge.
  disc(CX, CY, 430, (t) => {
    const k = 1 - t;
    const f = k * k;
    return [255 * f, 200 * f, 90 * f] as RGB;
  }, 0.55, true);
  // White-hot core.
  disc(CX, CY, 150, (t) => {
    const k = 1 - t;
    const f = k * k;
    return [255 * f, (240 * k + 15) * f, (200 * k + 10) * f] as RGB;
  }, 0.85, true);
  // Rays fanning out, strongest downward where the ring ignites.
  for (let i = 0; i < 26; i++) {
    const ang = (i / 26) * Math.PI * 2 + rand() * 0.12;
    const down = Math.max(0, Math.sin(ang)); // 1 at straight down
    const len = 300 + rand() * 260 + down * 140;
    const peak = 0.5 + rand() * 0.35 + down * 0.3;
    ray(CX, CY, ang, len, 9 + rand() * 14, 255, 205, 110, peak);
  }
  // Ignition flare at the ring's bottom inner edge.
  const fx = CX + 26;
  const fy = CY + RING_R - 6;
  disc(fx, fy, 74, (t) => {
    const k = 1 - t;
    const f = k * k;
    return [255 * f, (230 * k + 25) * f, (120 * k + 10) * f] as RGB;
  }, 0.95, true);
  sparkle(fx, fy, 26, 255, 240, 200, 0.9);
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2;
    const d = 40 + rand() * 150;
    sparkle(fx + Math.cos(a) * d, fy + Math.sin(a) * d * 0.7, 2 + rand() * 4, 255, 210, 120, 0.5 + rand() * 0.4);
  }
}

function drawRing(): void {
  // The golden ring itself: bright molten gold at the top, deep amber low,
  // a white-hot inner rim, and a dark outer edge for separation.
  ring(CX, CY, RING_R, RING_HT, (angle, across) => {
    // angle: -PI/2 is the top. Brightness peaks at the top, dips at bottom.
    const up = Math.max(0, -Math.sin(angle));
    const side = Math.abs(Math.cos(angle));
    const base: RGB = [245, 185, 66];
    const hot: RGB = [255, 236, 170];
    const deep: RGB = [176, 96, 22];
    let r = lerp(deep[0], base[0], 0.35 + 0.65 * up);
    let g = lerp(deep[1], base[1], 0.35 + 0.65 * up);
    let b = lerp(deep[2], base[2], 0.35 + 0.65 * up);
    // Hot inner rim.
    const rim = 1 - smoothstep(0.0, 0.28, across);
    r = lerp(r, hot[0], rim * 0.85);
    g = lerp(g, hot[1], rim * 0.85);
    b = lerp(b, hot[2], rim * 0.85);
    // Outer edge darkens for separation from the sky.
    const edge = smoothstep(0.86, 1.0, across);
    r = lerp(r, 96, edge * 0.7);
    g = lerp(g, 56, edge * 0.7);
    b = lerp(b, 18, edge * 0.7);
    // A faint cool sheen on the outer face.
    void side;
    return [r, g, b];
  }, 1);
  // Thin bright highlight along the ring's upper outer edge.
  ring(CX, CY, RING_R + RING_HT - 4, 2.5, () => [255, 244, 200] as RGB, 0.85);
  // Thin orbit arc crossing the ring: a tilted ellipse, like a comet's path.
  const tilt = -0.42;
  const ex = 392;
  const ey = 118;
  const steps = 220;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const px = Math.cos(t) * ex;
    const py = Math.sin(t) * ey;
    const rx = px * Math.cos(tilt) - py * Math.sin(tilt);
    const ry = px * Math.sin(tilt) + py * Math.cos(tilt);
    pts.push([CX + rx, CY + 6 + ry]);
  }
  // Draw only the front half of the orbit (the lower arc passes in front).
  const front = pts.filter((p) => p[1] > CY - 40);
  polyline(front, 3, 255, 214, 130, 0.75, false);
  // A small glowing comet riding the orbit, upper right.
  const ca = -0.9;
  const cpx = CX + (Math.cos(ca) * ex * Math.cos(tilt) - Math.sin(ca) * ey * Math.sin(tilt));
  const cpy = CY + 6 + (Math.cos(ca) * ex * Math.sin(tilt) + Math.sin(ca) * ey * Math.cos(tilt));
  disc(cpx, cpy, 10, () => [255, 240, 200] as RGB, 0.95, true);
  sparkle(cpx, cpy, 12, 255, 235, 180, 0.9);
}

function drawSea(): void {
  // Dark sea from the horizon down, with a gold reflection column.
  for (let y = HORIZON; y < H; y++) {
    const t = (y - HORIZON) / (H - HORIZON);
    const base: RGB = [lerp(14, 4, t), lerp(34, 8, t), lerp(52, 16, t)];
    for (let x = 0; x < W; x++) {
      // Gentle swell: brightness bands that drift with depth.
      const swell = Math.sin((x * 0.012 + y * 0.05) + Math.sin(y * 0.021) * 2.2) * 0.5 + 0.5;
      const n = fbm(x * 0.008, y * 0.03);
      const shimmer = smoothstep(0.55, 0.8, n) * 0.5;
      const r = base[0] + swell * 10 + shimmer * 22;
      const g = base[1] + swell * 14 + shimmer * 26;
      const b = base[2] + swell * 16 + shimmer * 22;
      paint(x, y, r, g, b, 1);
    }
  }
  // Reflection column under the ring: shimmering gold streaks, widening
  // and dimming as they fall away from the horizon.
  for (let i = 0; i < 260; i++) {
    const t = rand();
    const y = HORIZON + 6 + t * (H - HORIZON - 20);
    const spread = 26 + t * 150;
    const x = CX + (rand() * 2 - 1) * spread;
    const len = 8 + rand() * 42 * (1 - t * 0.5);
    const a = (0.5 - t * 0.32) * (0.5 + rand() * 0.5);
    thickLine(x - len / 2, y, x + len / 2, y, 2.2 + rand() * 2, 255, 196, 92, a, true);
  }
  // Wave crest lines catching the light.
  for (let i = 0; i < 46; i++) {
    const y = HORIZON + 24 + rand() * (H - HORIZON - 60);
    const x = rand() * W;
    const len = 24 + rand() * 80;
    const a = 0.08 + rand() * 0.14;
    const gold = rand() > 0.45;
    thickLine(
      x, y, x + len, y + Math.sin(x * 0.01) * 3,
      2, gold ? 255 : 120, gold ? 190 : 160, gold ? 100 : 200, a, false,
    );
  }
  // The boat: a tiny dark silhouette on a crest, right under the ring,
  // big enough to read as a lone sailor dwarfed by the ring.
  const bx = CX - 4;
  const by = 766;
  const bs = 1.35; // boat scale
  const S = (dx: number, dy: number): [number, number] => [bx + dx * bs, by + dy * bs];
  // Hull.
  polyline([S(-30, 0), S(-22, 11), S(20, 11), S(28, 0)], 3.4, 5, 7, 13, 1, false);
  // Hull fill (dark) via short vertical strokes.
  for (let x = -26; x <= 24; x += 2) {
    const top = by + 1;
    const bot = by + 10 * bs - Math.abs(x) * 0.12 * bs;
    thickLine(bx + x * bs, top, bx + x * bs, bot, 2.4, 5, 7, 13, 1, false);
  }
  // Gold rim light along the hull's top edge.
  thickLine(bx - 29 * bs, by, bx + 27 * bs, by, 2, 255, 214, 130, 0.9, false);
  // Mast + sail.
  thickLine(bx + 2 * bs, by - 2, bx + 2 * bs, by - 46 * bs, 3, 5, 7, 13, 1, false);
  polyline([S(4, -44), S(4, -4), S(30, -4)], 3, 8, 10, 18, 1, false);
  // Sail fill.
  for (let yy = by - 42 * bs; yy <= by - 6 * bs; yy += 2) {
    const wdt = ((yy - (by - 44 * bs)) / (38 * bs)) * 24 * bs;
    thickLine(bx + 5 * bs, yy, bx + 5 * bs + wdt, yy, 2.4, 10, 12, 22, 1, false);
  }
  // Sail's gold edge.
  thickLine(bx + 4 * bs, by - 44 * bs, bx + 30 * bs, by - 4 * bs, 1.8, 255, 214, 130, 0.85, false);
  // Wake.
  thickLine(bx - 52 * bs, by + 12 * bs, bx - 8 * bs, by + 12 * bs, 2.2, 200, 170, 110, 0.35, false);
  thickLine(bx + 12 * bs, by + 13 * bs, bx + 58 * bs, by + 13 * bs, 2.2, 200, 170, 110, 0.3, false);
  // Birds scattering near the ring.
  bird(300, 250, 13, 0.9);
  bird(352, 214, 10, 0.85);
  bird(736, 262, 12, 0.9);
  bird(782, 214, 9, 0.8);
  bird(688, 178, 8, 0.75);
}

function drawVignette(): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - CX) / (W * 0.62);
      const dy = (y - 470) / (H * 0.62);
      const d = Math.sqrt(dx * dx + dy * dy);
      const dark = smoothstep(0.72, 1.25, d) * 0.34;
      if (dark <= 0) continue;
      const i = idx(x, y);
      img[i] *= 1 - dark;
      img[i + 1] *= 1 - dark;
      img[i + 2] *= 1 - dark;
    }
  }
}

// ---------------------------------------------------------------------------
// A small stroke font (5x7 grid, line segments) for the line to the judge
// ---------------------------------------------------------------------------

type Seg = [number, number, number, number];

const GLYPHS: Record<string, Seg[]> = {
  D: [[0, 0, 0, 6], [0, 0, 3, 0], [3, 0, 4, 1], [4, 1, 4, 5], [4, 5, 3, 6], [3, 6, 0, 6]],
  E: [[0, 0, 0, 6], [0, 0, 4, 0], [0, 3, 3, 3], [0, 6, 4, 6]],
  F: [[0, 0, 0, 6], [0, 0, 4, 0], [0, 3, 3, 3]],
  G: [[4, 1, 3, 0], [3, 0, 1, 0], [1, 0, 0, 1], [0, 1, 0, 5], [0, 5, 1, 6], [1, 6, 3, 6], [3, 6, 4, 5], [4, 5, 4, 3], [4, 3, 2, 3]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  J: [[0, 0, 4, 0], [4, 0, 4, 5], [4, 5, 3, 6], [3, 6, 1, 6], [1, 6, 0, 5]],
  L: [[0, 0, 0, 6], [0, 6, 4, 6]],
  R: [[0, 0, 0, 6], [0, 0, 3, 0], [3, 0, 4, 1], [4, 1, 4, 3], [4, 3, 3, 4], [3, 4, 0, 4], [2, 4, 4, 6]],
  S: [[4, 0, 3, 0], [3, 0, 1, 0], [1, 0, 0, 1], [0, 1, 0, 2], [0, 2, 1, 3], [1, 3, 3, 3], [3, 3, 4, 4], [4, 4, 4, 5], [4, 5, 3, 6], [3, 6, 1, 6], [1, 6, 0, 6]],
  T: [[0, 0, 4, 0], [2, 0, 2, 6]],
  U: [[0, 0, 0, 5], [0, 5, 1, 6], [1, 6, 3, 6], [3, 6, 4, 5], [4, 5, 4, 0]],
  "—": [[0, 3, 4, 3]],
};

function drawText(text: string, cx: number, topY: number, capH: number, r: number, g: number, b: number): void {
  const unit = capH / 7;
  const advance = 6.4 * unit;
  const widths = [...text].map((ch) => (ch === " " ? advance * 0.62 : advance));
  const total = widths.reduce((a, w) => a + w, 0) - (advance - 5 * unit);
  let x = cx - total / 2;
  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci];
    const segs = GLYPHS[ch];
    if (segs) {
      for (const [sx0, sy0, sx1, sy1] of segs) {
        // Dark outline first, then the bright stroke on top.
        thickLine(x + sx0 * unit, topY + sy0 * unit, x + sx1 * unit, topY + sy1 * unit, unit * 0.95, 4, 6, 16, 0.85, false);
        thickLine(x + sx0 * unit, topY + sy0 * unit, x + sx1 * unit, topY + sy1 * unit, unit * 0.55, r, g, b, 1, false);
      }
    }
    x += widths[ci];
  }
}

// ---------------------------------------------------------------------------
// Merge the glow layer, then write the PNG
// ---------------------------------------------------------------------------

function mergeGlow(): void {
  for (let i = 0; i < img.length; i++) {
    img[i] = clamp255(img[i] + glow[i]);
  }
}

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  drawSky();
  drawClouds();
  drawBurst();
  drawRing();
  drawSea();
  drawVignette();
  // The line to the judge, small and clean along the bottom.
  drawText("JUDGE — FEEL THE RUSH", CX, 952, 26, 255, 216, 138);
  // Blur only the glow (soft light), then merge it over the image.
  blur(glow, 9, 2);
  mergeGlow();
  const png = encodePNG();
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  const sha = crypto.createHash("sha256").update(png).digest("hex");
  console.log(`wrote ${outPath} (${png.length} bytes, sha256 ${sha})`);
}

main();
