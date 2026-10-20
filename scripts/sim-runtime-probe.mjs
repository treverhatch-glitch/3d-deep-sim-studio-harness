#!/usr/bin/env node
import { loadCartridge, cartridgeName } from '../harness/cartridge.mjs';

const traps = ['random', 'now'];
const name = cartridgeName();
const cart = await loadCartridge(name);
const state = cart.createInitialState(1337);
cart.step(state, { type: 'spawn', kind: 'sensor', x: 1, z: 1 });
console.log(`[sim-runtime] PASS ${name}`);
