import { randomUUID } from 'node:crypto';
import { connectMongoDB } from '../services/mongodbData.js';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const fail = (status, detail) => ({ status, data: { detail } });

export function createChatOrganizationController({ connect = connectMongoDB } = {}) {
  return {
    async list() {
      try {
        const db = await connect();
        const [projects, chats] = await Promise.all([
          db.collection('chat_projects').find({}).sort({ created_at: 1, _id: 1 }).toArray(),
          db.collection('chat_organization').find({}).toArray(),
        ]);
        return { status: 200, data: {
          projects: projects.map(({ _id, name }) => ({ id: _id, name })),
          chats: chats.map(({ _id, project_id = null, pinned = false }) => ({ conversation_id: _id, project_id, pinned })),
        } };
      } catch { return fail(503, 'Chat organization is unavailable. Please retry.'); }
    },
    async createProject(body) {
      if (typeof body?.name !== 'string' || !body.name.trim() || body.name.trim().length > 80)
        return fail(400, 'Use a project name between 1 and 80 characters.');
      try {
        const db = await connect();
        const project = { _id: randomUUID(), name: body.name.trim(), created_at: new Date() };
        await db.collection('chat_projects').insertOne(project);
        return { status: 201, data: { project: { id: project._id, name: project.name } } };
      } catch { return fail(503, 'The project could not be saved. Please retry.'); }
    },
    async updateChat(body) {
      if (!validId(body?.conversation_id) ||
          (body.project_id !== undefined && body.project_id !== null && !validId(body.project_id)) ||
          (body.pinned !== undefined && typeof body.pinned !== 'boolean') ||
          (body.project_id === undefined && body.pinned === undefined))
        return fail(400, 'Provide a conversation and a valid project or pin setting.');
      try {
        const db = await connect();
        if (!await db.collection('conversation_histories').findOne({ conversation_code: body.conversation_id }, { projection: { _id: 1 } }))
          return fail(404, 'This saved chat could not be found.');
        if (body.project_id && !await db.collection('chat_projects').findOne({ _id: body.project_id }))
          return fail(404, 'This project could not be found.');
        const changes = {};
        if (body.project_id !== undefined) changes.project_id = body.project_id;
        if (body.pinned !== undefined) changes.pinned = body.pinned;
        await db.collection('chat_organization').updateOne({ _id: body.conversation_id }, { $set: changes }, { upsert: true });
        return { status: 200, data: { status: 'ok' } };
      } catch { return fail(503, 'The chat could not be organized. Please retry.'); }
    },
  };
}

export const chatOrganization = createChatOrganizationController();
