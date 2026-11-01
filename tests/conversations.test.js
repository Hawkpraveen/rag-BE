import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationController } from '../src/controllers/conversationController.js';
import { createConversationStore } from '../src/services/conversationStore.js';

const body = { question: 'Refund policy?', conversation_id: 'chat-1', request_id: 'request-1' };
const result = { answer: '21 days [1].', sources: [{ id: 1, text: '21 days', source: 'policy.txt' }],
  token_usage: [{ operation: 'embedding', model_name: 'embed', input_tokens: 4, output_tokens: 0 },
    { operation: 'chat', model_name: 'chat', input_tokens: 50, output_tokens: 9 }] };

function memoryStore() {
  const turns = new Map(), logs = [];
  return { turns, logs,
    async start(turn) {
      if (turns.has(turn._id)) return structuredClone(turns.get(turn._id));
      turns.set(turn._id, structuredClone(turn)); return null;
    },
    async finish(id, completed, usage) { Object.assign(turns.get(id), structuredClone(completed)); logs.push(...usage); },
    async list() { return [{ conversation_id: 'chat-1', title: 'Refund policy?' }]; },
    async history(id) { return [...turns.values()].filter(turn => turn.conversation_code === id).reverse(); },
  };
}

test('saves the question before the agent, then the answer, sources and per-model token usage', async () => {
  const store = memoryStore();
  const controller = createConversationController({ store, send: async (path, payload) => {
    assert.equal(store.turns.get(body.request_id).status, 'pending');
    assert.equal(path, '/ask');
    assert.deepEqual(payload, { question: body.question, top_k: 4, min_score: 0.25, model_mode: 'auto' });
    return { status: 200, data: result };
  } });
  assert.equal((await controller.chat(body)).status, 200);
  const saved = store.turns.get(body.request_id);
  assert.equal(saved.status, 'completed');
  assert.deepEqual(saved.result.sources, result.sources);
  assert.equal(store.logs.length, 2);
  assert.deepEqual(store.logs.map(log => [log.input_tokens, log.output_tokens]), [[4, 0], [50, 9]]);
  assert.deepEqual(store.logs.map(log => log.total_tokens), [4, 59]);
  assert.ok(store.logs.every(log => log.request_id === body.request_id && log.conversation_code === body.conversation_id));
  const reloaded = createConversationController({ store });
  const history = await reloaded.history(new URL('http://test?conversation_id=chat-1'));
  assert.equal(history.data.turns[0].question, body.question);
  assert.equal(history.data.turns[0].answer, result.answer);
  assert.deepEqual(history.data.turns[0].token_usage, result.token_usage);
});

test('duplicate requests replay the saved result without another model call', async () => {
  const store = memoryStore(); let calls = 0;
  const controller = createConversationController({ store, send: async () => { calls++; return { status: 200, data: result }; } });
  const first = await controller.chat(body);
  assert.deepEqual(await controller.chat(body), first);
  assert.equal(calls, 1); assert.equal(store.logs.length, 2);
  assert.equal((await controller.chat({ ...body, question: 'Different question' })).status, 409);
  assert.equal((await controller.chat({ ...body, conversation_id: 'other' })).status, 409);
});

test('pending duplicates never start a second agent request', async () => {
  const store = memoryStore(); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const controller = createConversationController({ store, send: async () => { await waiting; return { status: 200, data: result }; } });
  const first = controller.chat(body);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await controller.chat(body)).status, 409);
  release(); await first;
});

test('database failures prevent agent calls or prevent an unsaved success response', async () => {
  let calls = 0;
  const unavailable = createConversationController({ store: { start: async () => { throw new Error('offline'); } }, send: () => { calls++; } });
  assert.equal((await unavailable.chat(body)).status, 503); assert.equal(calls, 0);
  const store = memoryStore();
  store.finish = async () => { throw new Error('offline'); };
  const controller = createConversationController({ store, send: async () => ({ status: 200, data: result }) });
  assert.equal((await controller.chat(body)).status, 503);
  assert.equal(store.turns.get(body.request_id).status, 'pending');
});

test('failed responses retain reported spend and unknown counts stay null', async () => {
  const store = memoryStore();
  const controller = createConversationController({ store, send: async () => ({ status: 502, data: {
    detail: 'Invalid citation', token_usage: [{ operation: 'chat', model_name: 'chat', input_tokens: null, output_tokens: 20 }],
  } }) });
  assert.equal((await controller.chat(body)).status, 502);
  assert.equal(store.turns.get(body.request_id).status, 'failed');
  assert.equal(store.logs[0].input_tokens, null); assert.equal(store.logs[0].output_tokens, 20);
  assert.equal(store.logs[0].total_tokens, null);
  assert.equal(store.logs[0].status, 'failed');
});

test('validates inputs and cursors before touching storage', async () => {
  const controller = createConversationController({ store: {}, send: () => { throw new Error('must not call'); } });
  for (const invalid of [{ question: '' }, { ...body, request_id: {} }, { ...body, conversation_id: '../bad' },
    { ...body, top_k: 7 }, { ...body, min_score: '0.25' }, { ...body, model_mode: 'random-model' }]) assert.equal((await controller.chat(invalid)).status, 400);
  for (const query of ['', '?conversation_id=../bad', '?conversation_id=chat-1&before=bad'])
    assert.equal((await controller.history(new URL('http://test/' + query))).status, 400);
});

test('forwards mode, persists routing and rejects mode changes on replay', async () => {
  const store = memoryStore(); let sent;
  const routing = { mode: 'thorough', model: 'large', reason: 'Thorough mode selected' };
  const controller = createConversationController({ store, send: async (_path, request) => {
    sent = request; return { status: 200, data: { ...result, routing } };
  } });
  const response = await controller.chat({ ...body, model_mode: 'thorough' });
  assert.equal(response.status, 200);
  assert.equal(sent.model_mode, 'thorough');
  assert.deepEqual(store.turns.get(body.request_id).result.routing, routing);
  assert.equal((await controller.chat({ ...body, model_mode: 'fast' })).status, 409);
});

test('history is bounded, chronological and provides a cursor without losing same-time turns', async () => {
  const date = new Date('2026-11-01T00:00:00Z'); let cursor;
  const store = { history: async (_, before) => {
    cursor = before;
    return Array.from({ length: before ? 1 : 51 }, (_, index) => ({
      _id: String(100 - index), question: 'Q', created_at: date, status: 'completed', result: { answer: 'A' },
    }));
  } };
  const controller = createConversationController({ store });
  const first = await controller.history(new URL('http://test?conversation_id=chat-1'));
  assert.equal(first.data.turns.length, 50);
  assert.equal(first.data.turns[0].request_id, '51');
  assert.equal(first.data.turns.at(-1).request_id, '100');
  await controller.history(new URL(`http://test?conversation_id=chat-1&before=${first.data.next_cursor}`));
  assert.deepEqual(cursor, { id: '51', created_at: date.toISOString() });
});

test('store uses one transaction for answer and usage and always closes its session', async () => {
  const events = []; const session = {
    async withTransaction(work) { events.push('begin'); await work(); events.push('commit'); },
    async endSession() { events.push('close'); },
  };
  let failLogs = false;
  const database = { client: { startSession: () => session }, collection(name) { return {
    async createIndex() {},
    async updateOne(_filter, _update, options) { assert.equal(options.session, session); events.push('answer'); },
    async insertMany(_usage, options) { assert.equal(options.session, session); events.push(name); if (failLogs) throw new Error('log failure'); },
  }; } };
  const store = createConversationStore(async () => database);
  await store.finish('request-1', {}, [{}]);
  assert.deepEqual(events, ['begin', 'answer', 'provider_usage_logs', 'commit', 'close']);
  events.length = 0; failLogs = true;
  await assert.rejects(store.finish('request-1', {}, [{}]), /log failure/);
  assert.deepEqual(events, ['begin', 'answer', 'provider_usage_logs', 'close']);
});
