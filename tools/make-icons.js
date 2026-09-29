/* Generates icons/icon{16,48,128}.png with no image-library dependency.
   Run:  node tools/make-icons.js
   Draws a rounded blue square holding three "list row" bars with a strike
   through them - a results list with entries filtered out. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SS = 4; // supersampling factor, for antialiasing

const BG = [10, 102, 194];   // LinkedIn blue
const FG = [255, 255, 255];

function draw(size) {
  const S = size * SS;
  const px = new Float64Array(S * S * 4); // r,g,b,a accumulated at 0..255

  const radius = S * 0.22;
  const inRounded = (x, y) => {
    const rx = Math.min(x, S - 1 - x);
    const ry = Math.min(y, S - 1 - y);
    if (rx >= radius || ry >= radius) return true;
    const dx = radius - rx, dy = radius - ry;
    return dx * dx + dy * dy <= radius * radius;
  };

  // bars: three rows
  const barH = S * 0.11;
  const barX0 = S * 0.20;
  const barX1 = S * 0.80;
  const rows = [0.28, 0.45, 0.62].map(t => t * S);

  // strike: diagonal band from bottom-left to top-right
  const strikeHalf = S * 0.055;
  const onStrike = (x, y) => {
    // line through (0.16S, 0.80S) -> (0.84S, 0.24S)
    const x1 = 0.14 * S, y1 = 0.82 * S, x2 = 0.86 * S, y2 = 0.22 * S;
    const dx = x2 - x1, dy = y2 - y1;
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t < 0 || t > 1) return false;
    const px_ = x1 + t * dx, py_ = y1 + t * dy;
    return Math.hypot(x - px_, y - py_) <= strikeHalf;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!inRounded(x, y)) { px[i + 3] = 0; continue; }

      let c = BG;
      for (const cy of rows) {
        if (y >= cy - barH / 2 && y <= cy + barH / 2 && x >= barX0 && x <= barX1) c = FG;
      }
      if (onStrike(x, y)) c = FG;

      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }

  // box-downsample SS x SS -> 1
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (((y * SS + sy) * S) + (x * SS + sx)) * 4;
          const al = px[i + 3] / 255;
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, png(draw(size), size));
  console.log('wrote', path.relative(path.join(__dirname, '..'), file));
}
