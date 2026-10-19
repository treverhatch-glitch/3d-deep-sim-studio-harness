// Hatchfield Mission Control HUB — zero-token local server
// Serves the sci-fi dashboard and streams /tmp/agent-events.jsonl
// Run: node hub/server.js
// Then open: http://localhost:3847

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3847;
const EVENTS = '/tmp/agent-events.jsonl';

const server = http.createServer((req, res) => {
  // CORS for local flexibility
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Failed to load index.html');
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
  console.log('  HATCHFIELD // MISSION CONTROL');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Watching: ${EVENTS}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
