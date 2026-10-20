import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function repoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
}

export function cartridgeName(argv = process.argv) {
  const flag = argv.indexOf('--cartridge');
  if (flag >= 0 && argv[flag + 1]) return argv[flag + 1];
  if (process.env.STUDIO_CARTRIDGE) return process.env.STUDIO_CARTRIDGE;
  try {
    const gates = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'studio', 'gates.json'), 'utf8'));
    if (gates.cartridge) return gates.cartridge;
  } catch {}
  return 'example-sim';
}

export async function loadCartridge(name = cartridgeName()) {
  const root = repoRoot();
  const dir = path.join(root, 'cartridges', name);
  const index = path.join(dir, 'index.mjs');
  const qa = path.join(dir, 'qa.mjs');
  if (!fs.existsSync(index)) throw new Error(`missing cartridge ${name}`);
  const mod = await import(pathToFileURL(index).href);
  const qaMod = fs.existsSync(qa) ? await import(pathToFileURL(qa).href) : null;
  return { name, dir, ...mod, qa: qaMod };
}
