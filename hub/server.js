// AI Game Studio Mission Control HUB — zero-token local server
// Default: serves the React Flow War Room build (or falls back to index.html)
// Streams .studio/events.jsonl
// Run: node hub/server.js
// Then open: http://localhost:3847

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3847;
const EVENTS = path.join(process.cwd(), '.studio', 'events.jsonl');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/index.html') {
    // Prefer a built War Room if present, otherwise the simple HTML feed
    const warRoomHtml = path.join(__dirname, 'dist', 'index.html');
    const fallback = path.join(__dirname, 'index.html');
    const file = fs.existsSync(warRoomHtml) ? warRoomHtml : fallback;
    try {
      const html = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Failed to load HUB');
    }
  } else if (req.url === '/events') {
    try {
      if (fs.existsSync(EVENTS)) {
        const data = fs.readFileSync(EVENTS, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(data);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('');
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AI GAME STUDIO // WAR ROOM');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Watching: ${EVENTS}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
