/**
 * Draws a floor-plan PNG for testing the phase 2 intake.
 *
 * Dependency-free: PNG is a signature, an IHDR, zlib-deflated scanlines and an
 * IEND, so a writer is short enough not to justify pulling in a canvas
 * library for one fixture.
 *
 * The blueprint is never parsed by the pipeline - intake uses it only as
 * something for a human (or a vision model) to describe - so this exists to
 * exercise the file path, not to be machine-read.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 1000, H = 720;
const buf = Buffer.alloc(W * H * 3, 0xff);

const px = (x, y, r, g, b) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const o = (y * W + x) * 3;
  buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
};
const rect = (x0, y0, x1, y1, r, g, b) => {
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) px(x, y, r, g, b);
  }
};
/** Wall as a thick stroke. */
const wall = (x0, y0, x1, y1, t = 9) => {
  if (y0 === y1) rect(x0, y0 - t / 2, x1, y1 + t / 2, 20, 30, 48);
  else rect(x0 - t / 2, y0, x1 + t / 2, y1, 20, 30, 48);
};
/** Dashed line, for door swings. */
const dash = (x0, y0, x1, y1) => {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i < steps; i++) {
    if ((i >> 2) % 2) continue;
    px(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), 120, 140, 165);
  }
};

// Paper tint
rect(0, 0, W, H, 0xf4, 0xf6, 0xfa);

// Outer shell
const L = 60, T = 60, R = 940, B = 660;
wall(L, T, R, T); wall(L, B, R, B); wall(L, T, L, B); wall(R, T, R, B);

// Interior partitions. Gaps are doorways.
wall(L, 380, 300, 380);            // living / kitchen divider
wall(560, T, 560, 250);            // hall wall, upper
wall(560, 340, 560, B);            // hall wall, lower  (gap 250-340 = doorway)
wall(560, 380, R, 380);            // between the two bedrooms
wall(300, 380, 300, 470);          // kitchen return (gap below = opening)

// Door swings
dash(560, 250, 560, 340);
dash(300, 470, 300, 560);

// Fixtures, drawn light so they read as furniture not structure
const soft = (x0, y0, x1, y1) => rect(x0, y0, x1, y1, 0xd8, 0xdf, 0xea);
soft(110, 120, 300, 300);   // sofa block, living
soft(360, 150, 500, 260);   // table, living
soft(110, 430, 280, 520);   // kitchen counter
soft(640, 110, 880, 300);   // bed, bedroom 1
soft(640, 430, 860, 600);   // bed, bedroom 2

writeFileSync('samples/blueprint.png', encodePng(W, H, buf));
console.log(`samples/blueprint.png  ${W}x${H}`);

/* --------------------------------- png ----------------------------------- */

function encodePng(w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

// `var`, not `let`: the top-level write call above runs before this line is
// evaluated, and a `let` would still be in its temporal dead zone.
var CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
