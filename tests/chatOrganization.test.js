import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatOrganizationController } from '../src/controllers/chatOrganizationController.js';

function fixture() {
  const tables = {
    chat_projects: new Map(), chat_organization: new Map(),
    conversation_histories: new Map([['turn-1', { _id: 'turn-1', conversation_code: 'chat-1' }]]),
  };
  const connect = async () => ({ collection(name) {
    const table = tables[name];
    return {
      find() {
        return { sort() { return this; }, toArray: async () => [...table.values()].map(row => structuredClone(row)) };
      },
      async findOne(query) { return [...table.values()].find(row => Object.entries(query).every(([key, value]) => row[key] === value)) || null; },
      async insertOne(row) { table.set(row._id, structuredClone(row)); },
      async updateOne(query, update, options) {
        assert.equal(options.upsert, true);
        table.set(query._id, { ...table.get(query._id), _id: query._id, ...structuredClone(update.$set) });
      },
    };
  } });
  return { tables, connect, controller: createChatOrganizationController({ connect }) };
}

test('project membership and pinning survive reloads and can be changed independently', async () => {
  const { controller, connect } = fixture();
  const created = await controller.createProject({ name: '  Research  ' });
  assert.equal(created.status, 201);
  assert.equal(created.data.project.name, 'Research');
  const id = created.data.project.id;
  assert.equal((await controller.updateChat({ conversation_id: 'chat-1', project_id: id })).status, 200);
  assert.equal((await controller.updateChat({ conversation_id: 'chat-1', pinned: true })).status, 200);
  const reopened = createChatOrganizationController({ connect });
  const result = await reopened.list();
  assert.deepEqual(result.data.projects, [{ id, name: 'Research' }]);
  assert.deepEqual(result.data.chats, [{ conversation_id: 'chat-1', project_id: id, pinned: true }]);
  await reopened.updateChat({ conversation_id: 'chat-1', project_id: null });
  assert.deepEqual((await reopened.list()).data.chats, [{ conversation_id: 'chat-1', project_id: null, pinned: true }]);
  await reopened.updateChat({ conversation_id: 'chat-1', pinned: false });
  assert.equal((await reopened.list()).data.chats[0].pinned, false);
});

test('invalid input and missing chats or projects cannot create orphan membership records', async () => {
  const { controller, tables } = fixture();
  for (const body of [null, {}, { name: ' ' }, { name: 'a'.repeat(81) }])
    assert.equal((await controller.createProject(body)).status, 400);
  for (const body of [null, {}, { conversation_id: 'chat-1' }, { conversation_id: '../chat', pinned: true },
    { conversation_id: 'chat-1', pinned: 'true' }, { conversation_id: 'chat-1', project_id: {} }])
    assert.equal((await controller.updateChat(body)).status, 400);
  assert.equal((await controller.updateChat({ conversation_id: 'unknown', pinned: true })).status, 404);
  assert.equal((await controller.updateChat({ conversation_id: 'chat-1', project_id: 'missing' })).status, 404);
  assert.equal(tables.chat_organization.size, 0);
});

test('database failures remain visible instead of reporting unsaved organization as successful', async () => {
  const controller = createChatOrganizationController({ connect: async () => { throw new Error('offline'); } });
  assert.equal((await controller.list()).status, 503);
  assert.equal((await controller.createProject({ name: 'Research' })).status, 503);
  assert.equal((await controller.updateChat({ conversation_id: 'chat-1', pinned: true })).status, 503);
});
