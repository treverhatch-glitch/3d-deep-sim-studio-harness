/**
 * qa/cartridge-adapter.mjs — kept for older imports. New code uses harness/cartridge.mjs directly.
 */
import { loadCartridge } from '../harness/cartridge.mjs';

export async function createCartridgeAdapter(name) {
  return (await loadCartridge(name)).createAdapter();
}
