import { health, ingest, question, datasets } from '../controllers/ragController.js';

import { upload } from '../controllers/uploadController.js';
import { conversations } from '../controllers/conversationController.js';
import { chatOrganization } from '../controllers/chatOrganizationController.js';

export const routes = new Map([
  ['GET /api/chat-organization', () => chatOrganization.list()],
  ['POST /api/chat-organization', body => chatOrganization.updateChat(body)],
  ['POST /api/projects', body => chatOrganization.createProject(body)],
  ['POST /api/documents/upload', body => upload(body)],
  ['GET /api/datasets', () => datasets()],
  ['GET /api/health', () => health()],
  ['POST /api/documents/ingest', body => ingest(body)],
  ['POST /api/chat', body => conversations.chat(body)],
  ['GET /api/conversations', () => conversations.list()],
  ['GET /api/conversation', (_, url) => conversations.history(url)],
  ['POST /api/search', body => question(body, true)],
]);
