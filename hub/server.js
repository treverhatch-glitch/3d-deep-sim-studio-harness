#!/usr/bin/env node
/**
 * hub/server.js — Mission Control War Room Backend & WebSocket Bridge Entrypoint
 *
 * Re-exports and launches `hub/server.mjs` so both `node hub/server.js` and
 * `node hub/server.mjs` work identically.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHubServer, startHubCli, broadcastSnapshot } from './server.mjs';

export { createHubServer, startHubCli, broadcastSnapshot };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startHubCli();
}
