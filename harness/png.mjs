/**
 * harness/png.mjs — 2.30o: a small PNG reader and writer (8-bit gray, gray+alpha, RGB, RGBA, palette),
 * so the visual proof gate can measure captures with no image library. Written for the harness.
 */
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode a PNG buffer to { width, height, rgba: Uint8Array } (8-bit, non-interlaced). */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let o = 8; let width = 0; let height = 0; let depth = 0; let ctype = 0; let interlace = 0; let pal = null; let trns = null;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o); const type = buf.toString('latin1', o + 4, o + 8); const d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { width = d.readUInt32BE(0); height = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') pal = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} not supported (8 only)`);
  if (interlace) throw new Error('interlaced PNG not supported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch) throw new Error(`PNG colour type ${ctype} not supported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const px = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0; const b = prev[x]; const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch; const t = i * 4;
    if (ctype === 0) { rgba[t] = rgba[t + 1] = rgba[t + 2] = px[s]; rgba[t + 3] = 255; }
    else if (ctype === 4) { rgba[t] = rgba[t + 1] = rgba[t + 2] = px[s]; rgba[t + 3] = px[s + 1]; }
    else if (ctype === 2) { rgba[t] = px[s]; rgba[t + 1] = px[s + 1]; rgba[t + 2] = px[s + 2]; rgba[t + 3] = 255; }
    else if (ctype === 6) { rgba[t] = px[s]; rgba[t + 1] = px[s + 1]; rgba[t + 2] = px[s + 2]; rgba[t + 3] = px[s + 3]; }
    else { const k = px[s]; rgba[t] = pal?.[k * 3] ?? 0; rgba[t + 1] = pal?.[k * 3 + 1] ?? 0; rgba[t + 2] = pal?.[k * 3 + 2] ?? 0; rgba[t + 3] = trns && k < trns.length ? trns[k] : 255; }
  }
  return { width, height, rgba };
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA pixels as a PNG (used by tests and fixtures). */
export function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
