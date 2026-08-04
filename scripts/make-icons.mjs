#!/usr/bin/env node
// Regenerates icons/icon{16,32,48,128}.png. Zero dependencies: rasterizes a
// bold "E" (it's just rectangles) on a warm rounded square, supersampled for
// anti-aliasing, and writes the PNGs with node:zlib.
//
//   node scripts/make-icons.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [16, 32, 48, 128];

const BG = [244, 162, 61];   // warm amber
const FG = [59, 35, 16];     // dark chocolate

// Geometry in fractions of the canvas. The E: one stem, three arms.
const CORNER_RADIUS = 0.22;
const RECTS = [
  // [x0, y0, x1, y1]
  [0.30, 0.26, 0.42, 0.74], // stem
  [0.30, 0.26, 0.72, 0.38], // top arm
  [0.30, 0.44, 0.66, 0.56], // middle arm (slightly shorter)
  [0.30, 0.62, 0.72, 0.74], // bottom arm
];

function insideRoundedSquare(x, y, size, radius) {
  const r = radius * size;
  const cx = x < r ? r : x > size - r ? size - r : x;
  const cy = y < r ? r : y > size - r ? size - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideGlyph(x, y, size) {
  for (const [x0, y0, x1, y1] of RECTS) {
    if (x >= x0 * size && x < x1 * size && y >= y0 * size && y < y1 * size) {
      return true;
    }
  }
  return false;
}

function renderRGBA(size) {
  const ss = size <= 32 ? 8 : 4; // heavier supersampling where pixels are scarce
  const big = size * ss;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Average the supersamples with premultiplied alpha.
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = px * ss + sx + 0.5;
          const y = py * ss + sy + 0.5;
          if (!insideRoundedSquare(x, y, big, CORNER_RADIUS)) continue;
          const [cr, cg, cb] = insideGlyph(x, y, big) ? FG : BG;
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      out[i] = alpha > 0 ? Math.round(r / (a / 255)) : 0;
      out[i + 1] = alpha > 0 ? Math.round(g / (a / 255)) : 0;
      out[i + 2] = alpha > 0 ? Math.round(b / (a / 255)) : 0;
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

// --- Minimal PNG encoder (8-bit RGBA, filter 0) ---
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // compression 0, filter 0, interlace 0

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePNG(renderRGBA(size), size));
  console.log(`wrote ${file}`);
}
