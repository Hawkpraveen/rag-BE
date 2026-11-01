import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { app } from '../src/app.js';
import { routes } from '../src/routes/ragRoutes.js';
import { createUploadHandler } from '../src/controllers/uploadController.js';

async function serve(handler, run) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function form(name, content) {
  const body = new FormData(); body.append('file', new Blob([content]), name); return body;
}

test('browser multipart reaches the private agent with exact bytes and publishes its dataset', async () => {
  const bytes = Buffer.from([37, 80, 68, 70, 45, 0, 255, 10]);
  const filename = 'Policy 2026.pdf';
  let forwarded = false;
  await serve(async (request, response) => {
    assert.equal(request.url, '/upload');
    assert.equal(decodeURIComponent(request.headers['x-filename']), filename);
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    const chunks = []; for await (const part of request) chunks.push(part);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    forwarded = true;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ filename, indexed_documents: 1 }));
  }, async agentUrl => {
    const previousUrl = process.env.AGENT_URL;
    const previous = routes.get('POST /api/documents/upload');
    process.env.AGENT_URL = agentUrl;
    routes.set('POST /api/documents/upload', createUploadHandler({ connect: async () => 'db',
      snapshot: async () => 'snapshot', load: async (db, snapshot, id) => {
        assert.deepEqual([db, snapshot, id], ['db', 'snapshot', 'local-documents']);
        return { status: 'ready' };
      } }));
    try {
      await serve(app, async url => {
        const response = await fetch(url + '/api/documents/upload', { method: 'POST', body: form(filename, bytes) });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).dataset.status, 'ready');
      });
    } finally {
      routes.set('POST /api/documents/upload', previous);
      if (previousUrl === undefined) delete process.env.AGENT_URL; else process.env.AGENT_URL = previousUrl;
    }
  });
  assert.equal(forwarded, true);
});

test('rejects invalid uploads before reaching the agent', async () => {
  await serve(app, async url => {
    for (const [body, expected] of [[form('bad.exe', 'binary'), 415], [form('empty.txt', ''), 400],
      [form('big.txt', new Uint8Array(10 * 1024 * 1024 + 1)), 413], [new FormData(), 400]]) {
      const response = await fetch(url + '/api/documents/upload', { method: 'POST', body });
      assert.equal(response.status, expected);
    }
    const duplicate = form('one.txt', 'first'); duplicate.append('file', new Blob(['second']), 'two.txt');
    assert.equal((await fetch(url + '/api/documents/upload', { method: 'POST', body: duplicate })).status, 400);
  });
});

test('agent errors and MongoDB publication errors cannot be reported as successful uploads', async () => {
  const body = { filename: 'policy.txt', content: Buffer.from('policy'), datasetId: 'local-documents' };
  const failedAgent = createUploadHandler({ send: async () => ({ status: 502, data: { detail: 'Embedding failed' } }),
    connect: async () => { throw new Error('must not reach MongoDB'); } });
  assert.equal((await failedAgent(body)).status, 502);
  const failedMongo = createUploadHandler({ send: async () => ({ status: 200, data: { indexed_documents: 1 } }),
    connect: async () => { throw new Error('offline'); } });
  const result = await failedMongo(body);
  assert.equal(result.status, 503);
  assert.match(result.data.detail, /indexed locally/);
});
