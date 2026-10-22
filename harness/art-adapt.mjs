#!/usr/bin/env node
/**
 * harness/art-adapt.mjs — adapt scouted art for the game.
 *
 *   npm run adapt -- <asset-id|file> [--palette <file.json>] [--max 1024] [--lod 3] [--by <who>]
 *
 * For PNG textures:
 * - Recolor to the nearest color in a palette.
 * - Downscale to a max dimension.
 *
 * For OBJ meshes:
 * - Fix common issues (degenerate faces, duplicate vertices).
 * - Generate level-of-detail (LOD) variants.
 *
 * Adapted assets are written to assets/adapted/, recorded in the asset manifest as derived from the
 * source, and credited if the source requires it.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { readManifest, writeManifest, entryFor } from './assets.mjs';
import { writeCredits } from './asset-scout.mjs';

const ADAPTED_DIR = path.join(REPO_ROOT, 'assets', 'adapted');

// --- PNG processing ---
// Based on the PNG specification: http://www.libpng.org/pub/png/spec/1.2/
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crc32Table;
function makeCrc32Table() {
  crc32Table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[n] = c;
  }
}

function crc32(buf) {
  if (!crc32Table) makeCrc32Table();
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function readChunks(buf) {
  const chunks = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file.');
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];

  if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}. Only 8-bit RGB/RGBA are supported.`);
  }
  const bpp = colorType === 6 ? 4 : 3;

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const inflated = zlib.inflateSync(idat);

  const pixels = Buffer.alloc(width * height * 4); // Always work with RGBA
  let prior = Buffer.alloc(width * bpp);
  let offset = 0;

  for (let y = 0; y < height; y++) {
    const filterType = inflated[offset++];
    const scanline = inflated.subarray(offset, offset + width * bpp);
    const recon = Buffer.alloc(width * bpp);
    offset += width * bpp;

    for (let x = 0; x < width * bpp; x++) {
      const a = x >= bpp ? recon[x - bpp] : 0;
      const b = prior[x];
      const c = x >= bpp ? prior[x - bpp] : 0;
      let val = scanline[x];
      switch (filterType) {
        case 0: break; // None
        case 1: val = (val + a) & 0xff; break; // Sub
        case 2: val = (val + b) & 0xff; break; // Up
        case 3: val = (val + Math.floor((a + b) / 2)) & 0xff; break; // Average
        case 4: { // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          if (pa <= pb && pa <= pc) val = (val + a) & 0xff;
          else if (pb <= pc) val = (val + b) & 0xff;
          else val = (val + c) & 0xff;
          break;
        }
        default: throw new Error(`Unknown filter type ${filterType}`);
      }
      recon[x] = val;
    }

    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      if (bpp === 4) {
        pixels[px] = recon[x * 4];
        pixels[px + 1] = recon[x * 4 + 1];
        pixels[px + 2] = recon[x * 4 + 2];
        pixels[px + 3] = recon[x * 4 + 3];
      } else {
        pixels[px] = recon[x * 3];
        pixels[px + 1] = recon[x * 3 + 1];
        pixels[px + 2] = recon[x * 3 + 2];
        pixels[px + 3] = 255;
      }
    }
    prior = recon;
  }
  return { width, height, pixels };
}

export function encodePng(width, height, pixels) {
  const bpp = 4;
  const scanlines = Buffer.alloc(height * (width * bpp + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * bpp + 1)] = 0; // Filter type 0
    pixels.copy(scanlines, y * (width * bpp + 1) + 1, y * width * bpp, (y + 1) * width * bpp);
  }

  const idat = zlib.deflateSync(scanlines);
  const chunks = [];

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  chunks.push({ type: 'IHDR', data: ihdr });
  chunks.push({ type: 'IDAT', data: idat });
  chunks.push({ type: 'IEND', data: Buffer.alloc(0) });

  const bufs = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(chunk.data.length, 0);
    bufs.push(len);

    const typeAndData = Buffer.concat([Buffer.from(chunk.type), chunk.data]);
    bufs.push(typeAndData);

    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    bufs.push(crc);
  }
  return Buffer.concat(bufs);
}

function recolor(pixels, palette) {
  const paletteRgb = palette.map((hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  });
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    let bestDist = Infinity;
    let bestColor = paletteRgb[0];
    for (const pColor of paletteRgb) {
      const dist = (r - pColor[0]) ** 2 + (g - pColor[1]) ** 2 + (b - pColor[2]) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        bestColor = pColor;
      }
    }
    pixels[i] = bestColor[0];
    pixels[i + 1] = bestColor[1];
    pixels[i + 2] = bestColor[2];
    // Alpha is preserved
  }
}

/** Box-filter downscale so the longest side is at most `max`, rounded down to a power of two. */
function downscale(width, height, pixels, max) {
  const pot = (n) => 2 ** Math.floor(Math.log2(Math.max(1, n)));
  const scale = Math.min(1, max / Math.max(width, height));
  const nw = Math.max(1, pot(Math.floor(width * scale)));
  const nh = Math.max(1, pot(Math.floor(height * scale)));
  if (nw === width && nh === height) return { width, height, pixels };
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * height) / nh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * width) / nw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / nw));
      const acc = [0, 0, 0, 0];
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) for (let c = 0; c < 4; c++) acc[c] += pixels[(sy * width + sx) * 4 + c];
      const cnt = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 4; c++) out[(y * nw + x) * 4 + c] = Math.round(acc[c] / cnt);
    }
  }
  return { width: nw, height: nh, pixels: out };
}

// --- OBJ processing ---
function parseObj(text) {
  const vertices = [];
  const normals = [];
  const faces = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') vertices.push(parts.slice(1).map(parseFloat));
    else if (parts[0] === 'vn') normals.push(parts.slice(1).map(parseFloat));
    else if (parts[0] === 'f') faces.push(parts.slice(1));
  }
  return { vertices, normals, faces };
}

function fixMesh(obj) {
  // Weld vertices
  const grid = {};
  const vmap = [];
  const newVertices = [];
  const scale = 1e5;
  for (let i = 0; i < obj.vertices.length; i++) {
    const v = obj.vertices[i];
    const key = `${Math.round(v[0] * scale)}/${Math.round(v[1] * scale)}/${Math.round(v[2] * scale)}`;
    if (grid[key] === undefined) {
      grid[key] = newVertices.length;
      newVertices.push(v);
    }
    vmap[i] = grid[key];
  }

  // Update faces and drop degenerate ones
  const newFaces = [];
  for (const face of obj.faces) {
    const newFace = face.map((vert) => {
      const vIndex = parseInt(vert.split('/')[0], 10) - 1;
      const newVIndex = vmap[vIndex] + 1;
      const parts = vert.split('/');
      parts[0] = newVIndex;
      // Drop invalid vn refs if no normals exist
      if (parts.length > 2 && parts[2] && obj.normals.length === 0) {
        return `${newVIndex}/${parts[1]}`;
      }
      if (parts.length > 2 && parts[2] && parseInt(parts[2], 10) > obj.normals.length) {
        return `${newVIndex}/${parts[1]}`;
      }
      return parts.join('/');
    });
    const indices = newFace.map((v) => v.split('/')[0]);
    if (new Set(indices).size >= 3) {
      newFaces.push(newFace);
    }
  }

  let out = '';
  for (const v of newVertices) out += `v ${v.join(' ')}\n`;
  for (const vn of obj.normals) out += `vn ${vn.join(' ')}\n`;
  for (const f of newFaces) out += `f ${f.join(' ')}\n`;
  return out;
}

function createLod(obj, level) {
  const gridSize = [0.1, 0.25, 0.5][level - 1];
  if (!gridSize) return null;

  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const v of obj.vertices) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], v[i]);
      max[i] = Math.max(max[i], v[i]);
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const cellSize = Math.max(...size) * gridSize;
  if (cellSize === 0) return fixMesh(obj);

  const grid = {};
  const vmap = [];
  for (let i = 0; i < obj.vertices.length; i++) {
    const v = obj.vertices[i];
    const key = `${Math.floor((v[0] - min[0]) / cellSize)}/${Math.floor((v[1] - min[1]) / cellSize)}/${Math.floor((v[2] - min[2]) / cellSize)}`;
    if (!grid[key]) grid[key] = [];
    grid[key].push(i);
  }

  const newVertices = [];
  for (const key in grid) {
    const indices = grid[key];
    const avg = [0, 0, 0];
    for (const i of indices) {
      avg[0] += obj.vertices[i][0];
      avg[1] += obj.vertices[i][1];
      avg[2] += obj.vertices[i][2];
    }
    avg[0] /= indices.length;
    avg[1] /= indices.length;
    avg[2] /= indices.length;
    const newIndex = newVertices.length;
    newVertices.push(avg);
    for (const i of indices) vmap[i] = newIndex;
  }

  // Point every face at its cell's vertex; faces that collapse are dropped by fixMesh.
  const faces = obj.faces.map((f) => f.map((vert) => {
    const parts = vert.split('/');
    parts[0] = String(vmap[parseInt(parts[0], 10) - 1] + 1);
    return parts.join('/');
  }));
  return fixMesh({ vertices: newVertices, normals: obj.normals, faces });
}

// --- Main logic ---
/** 2.30e: check a glTF 2.0 file (.gltf JSON or .glb binary) well enough to ship it unchanged. Returns problems. */
export function validateGltf(buf, ext, baseDir) {
  const problems = [];
  let json;
  let binLen = 0;
  if (ext === '.glb') {
    if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') return ['not a GLB (no glTF magic)'];
    if (buf.readUInt32LE(4) !== 2) problems.push(`GLB version ${buf.readUInt32LE(4)}, need 2`);
    if (buf.readUInt32LE(8) !== buf.length) problems.push(`GLB header says ${buf.readUInt32LE(8)} bytes, file has ${buf.length}`);
    let off = 12;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32LE(off);
      const type = buf.readUInt32LE(off + 4);
      if (off + 8 + len > buf.length) { problems.push('a GLB chunk runs past the end of the file'); break; }
      if (type === 0x4e4f534a && json === undefined) {
        try { json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len)); } catch { problems.push('the GLB JSON chunk does not parse'); }
      } else if (type === 0x004e4942) binLen = len;
      off += 8 + len;
    }
    if (json === undefined && !problems.length) problems.push('no JSON chunk');
  } else {
    try { json = JSON.parse(buf.toString('utf8')); } catch { return ['the .gltf JSON does not parse']; }
  }
  if (!json) return problems;
  if (String(json.asset?.version || '') !== '2.0') problems.push(`asset.version is "${json.asset?.version ?? 'missing'}", need "2.0"`);
  (json.buffers || []).forEach((b, i) => {
    if (b.uri == null) { if (ext !== '.glb' || i !== 0) problems.push(`buffer ${i} has no uri`); else if (binLen < b.byteLength) problems.push(`buffer 0 needs ${b.byteLength} bytes, the BIN chunk has ${binLen}`); return; }
    if (/^data:/.test(b.uri)) return;
    const f = path.join(baseDir, decodeURIComponent(b.uri));
    if (!fs.existsSync(f)) problems.push(`buffer ${i} file ${b.uri} is missing`);
    else if (fs.statSync(f).size < b.byteLength) problems.push(`buffer ${i} file ${b.uri} is shorter than byteLength`);
  });
  (json.bufferViews || []).forEach((v, i) => {
    const b = (json.buffers || [])[v.buffer];
    if (!b) problems.push(`bufferView ${i} points at missing buffer ${v.buffer}`);
    else if ((v.byteOffset || 0) + v.byteLength > b.byteLength) problems.push(`bufferView ${i} runs past its buffer`);
  });
  (json.accessors || []).forEach((a, i) => { if (a.bufferView != null && !(json.bufferViews || [])[a.bufferView]) problems.push(`accessor ${i} points at missing bufferView ${a.bufferView}`); });
  (json.images || []).forEach((im, i) => { if (im.uri && !/^data:/.test(im.uri) && !fs.existsSync(path.join(baseDir, decodeURIComponent(im.uri)))) problems.push(`image ${i} file ${im.uri} is missing`); });
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const sourceArg = args.find((a) => !a.startsWith('--'));
  const opt = (k) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (i >= 0 ? true : false);
  };
  const by = opt('by') || process.env.STUDIO_LOCK_OWNER || 'art-adapter';
  if (!sourceArg || !by) {
    console.error('Usage: npm run adapt -- <asset-id|file> [--palette <file.json>] [--max 1024] [--lod 3] --by <who>');
    process.exit(1);
  }

  const m = readManifest();
  const sourceAsset = m.assets.find((a) => a.id === sourceArg || a.file === sourceArg);
  if (!sourceAsset) {
    console.error(`Source asset '${sourceArg}' not found in manifest.`);
    process.exit(1);
  }

  const sourcePath = path.join(REPO_ROOT, sourceAsset.file);
  const sourceData = fs.readFileSync(sourcePath);
  const ext = path.extname(sourceAsset.file).toLowerCase();
  const steps = [];
  const adaptedMeta = {};

  fs.mkdirSync(ADAPTED_DIR, { recursive: true });

  if (ext === '.png') {
    let { width, height, pixels } = decodePng(sourceData);
    // Resize first, then recolour: averaging after the recolour would make colours off the palette.
    const max = Number(opt('max')) || 1024;
    const res = downscale(width, height, pixels, max);
    if (res.width !== width || res.height !== height) steps.push(`resize ${width}x${height} -> ${res.width}x${res.height}`);
    ({ width, height, pixels } = res);
    adaptedMeta.max = max;
    const defPalette = path.join(REPO_ROOT, 'studio', 'art', 'palette.json');
    if (opt('palette') || fs.existsSync(defPalette)) {
      const palettePath = opt('palette') ? path.resolve(String(opt('palette'))) : defPalette;
      const palette = JSON.parse(fs.readFileSync(palettePath, 'utf8'));
      recolor(pixels, palette.colors);
      steps.push('recolor');
      adaptedMeta.palette = path.relative(REPO_ROOT, palettePath);
    }
    const outData = encodePng(width, height, pixels);
    const outPath = path.join(ADAPTED_DIR, path.basename(sourceAsset.file));
    fs.writeFileSync(outPath, outData);
    console.log(`Adapted PNG written to ${outPath}`);
    await recordAdaptation(sourceAsset, outPath, steps, adaptedMeta, by);
  } else if (ext === '.obj') {
    const obj = parseObj(sourceData.toString('utf8'));
    const baseName = path.basename(sourceAsset.file, '.obj');

    const fixed = fixMesh(obj);
    const outPath = path.join(ADAPTED_DIR, `${baseName}.obj`);
    fs.writeFileSync(outPath, fixed);
    console.log(`Fixed mesh written to ${outPath}`);
    await recordAdaptation(sourceAsset, outPath, ['fix'], {}, by);

    const lodCount = Number(opt('lod') || 0);
    adaptedMeta.lod = lodCount;
    for (let i = 1; i <= lodCount; i++) {
      const lodObj = createLod(obj, i);
      if (lodObj) {
        const lodPath = path.join(ADAPTED_DIR, `${baseName}.lod${i}.obj`);
        fs.writeFileSync(lodPath, lodObj);
        console.log(`LOD ${i} written to ${lodPath}`);
        await recordAdaptation(sourceAsset, lodPath, [`lod${i}`], { lod: i }, by);
      }
    }
  } else if (ext === '.gltf' || ext === '.glb') {
    // Passthrough: checked, then copied unchanged (no recolour or LODs for glTF yet). A .gltf's external files must sit beside it.
    const problems = validateGltf(sourceData, ext, path.dirname(sourcePath));
    if (problems.length) {
      console.error(`Not a valid glTF 2.0 file, not adapted:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    if (ext === '.gltf') {
      const j = JSON.parse(sourceData.toString('utf8'));
      const ext2 = [...(j.buffers || []), ...(j.images || [])].filter((x) => x.uri && !/^data:/.test(x.uri)).map((x) => x.uri);
      if (ext2.length) {
        console.error(`This .gltf points at files beside it (${ext2.join(', ')}); only the .gltf would be copied. Use a .glb or embedded data: URIs.`);
        process.exit(1);
      }
    }
    const outPath = path.join(ADAPTED_DIR, path.basename(sourceAsset.file));
    fs.writeFileSync(outPath, sourceData);
    console.log(`glTF checked and copied unchanged to ${outPath}`);
    await recordAdaptation(sourceAsset, outPath, ['validate-gltf', 'passthrough'], {}, by);
  } else {
    console.error(`Can't adapt ${ext} yet: PNG, OBJ, and glTF/GLB (checked, passed through unchanged) only.`);
    process.exit(1);
  }
}

async function recordAdaptation(sourceAsset, outPath, steps, adaptedMeta, by) {
  const m = readManifest();
  const rel = path.relative(REPO_ROOT, outPath).replace(/\\/g, '/');
  const existing = m.assets.find((a) => a.file === rel);
  const id = existing?.id || `A-${String(m.assets.reduce((x, a) => Math.max(x, Number(a.id.slice(2))), 0) + 1).padStart(3, '0')}`;

  const entry = entryFor(rel, {
    id,
    owner: sourceAsset.owner,
    licence: sourceAsset.licence,
    origin: sourceAsset.origin || sourceAsset.source || '',
    by,
    author: sourceAsset.author,
    credit: sourceAsset.credit,
    madeBy: by,
    kind: sourceAsset.kind,
  });

  entry.derivedFrom = sourceAsset.id;
  entry.adapted = { steps, ...adaptedMeta };

  m.assets = existing ? m.assets.map((a) => (a.file === rel ? entry : a)) : [...m.assets, entry];
  writeManifest(m);
  writeCredits();
  emitEvent({ type: 'asset.added', agent: by, to: 'producer', msg: `${id} ${rel} adapted from ${sourceAsset.id} by ${by}` });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
