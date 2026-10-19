#!/usr/bin/env node
// Compatibility entrypoint so both `node hub/server.js` and `node hub/server.mjs` launch the War Room HUB.
import { startHubCli } from './server.mjs';
startHubCli();
