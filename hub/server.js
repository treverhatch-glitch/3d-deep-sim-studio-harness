// Minimal zero-token server for the Mission Control HUB.
// Serves the HTML and streams /tmp/agent-events.jsonl
// Run: node hub/server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3847;
const EVENTS = '/tmp/agent-events.jsonl';

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (req.url === '/events') {
    if (fs.existsSync(EVENTS)) {
      const data = fs.readFileSync(EVENTS, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(data);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Mission Control HUB running at http://localhost:${PORT}`);
  console.log(`Watching ${EVENTS}`);
});
