import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { app } from '../src/app.js';

async function withServer(run) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('rejects invalid questions before calling the agent', () => withServer(async url => {
  const response = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '   ' }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).detail, /question/);
}));

test('rejects malformed JSON', () => withServer(async url => {
  const response = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
}));

test('blocks requests from unrelated browser origins', () => withServer(async url => {
  const response = await fetch(url + '/api/health', { headers: { Origin: 'https://unrelated.example' } });
  assert.equal(response.status, 403);
}));

test('handles preflight for the frontend origin', () => withServer(async url => {
  const response = await fetch(url + '/api/chat', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8080' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8080');
}));

test('returns 404 for unregistered paths', () => withServer(async url => {
  assert.equal((await fetch(url + '/api/arbitrary')).status, 404);
}));

test('history query parameters reach validation before any database access', () => withServer(async url => {
  for (const query of ['', '?conversation_id=../bad', '?conversation_id=chat-1&before=bad']) {
    const response = await fetch(url + '/api/conversation' + query);
    assert.equal(response.status, 400);
  }
}));
