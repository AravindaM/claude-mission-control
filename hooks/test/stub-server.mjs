// Stub mission-control server for hook tests.
// Usage: node stub-server.mjs <port> <capture-file> [brief-size-bytes]
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const [port, captureFile, briefSize] = process.argv.slice(2);

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    appendFileSync(captureFile, JSON.stringify({ url: req.url, body: JSON.parse(body || '{}') }) + '\n');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/hooks/session-start') {
      const brief = briefSize ? '#'.repeat(Number(briefSize)) : '# Task brief\nGoal: test.';
      res.end(JSON.stringify({ status_line: 'mission-control: attached to test-task', brief }));
    } else {
      res.end('{}');
    }
  });
});
server.listen(Number(port), '127.0.0.1', () => console.log('ready'));
