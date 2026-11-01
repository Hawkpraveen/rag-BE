import { randomUUID } from 'node:crypto';
import { callAgent } from '../services/agentClient.js';
import { createConversationStore } from '../services/conversationStore.js';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const fail = (status, detail) => ({ status, data: { detail } });
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createConversationController({ store = createConversationStore(), send = callAgent } = {}) {
  return {
    async chat(body) {
      if (typeof body?.question !== 'string' || !body.question.trim() || body.question.length > 4000)
        return fail(400, 'Provide a question between 1 and 4000 characters.');
      const conversationId = body.conversation_id ?? randomUUID();
      const requestId = body.request_id ?? randomUUID();
      if (!validId(conversationId) || !validId(requestId)) return fail(400, 'Invalid conversation_id or request_id.');
      const topK = body.top_k ?? 4, minScore = body.min_score ?? 0.25;
      const modelMode = body.model_mode ?? 'auto';
      if (!['auto', 'fast', 'thorough'].includes(modelMode)) return fail(400, 'Use auto, fast, or thorough model mode.');
      if (!Number.isInteger(topK) || topK < 1 || topK > 6 || typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < -1 || minScore > 1)
        return fail(400, 'Invalid retrieval settings.');
      const question = body.question.trim(), now = new Date();
      let existing;
      try {
        existing = await store.start({ _id: requestId, conversation_code: conversationId,
          question, top_k: topK, min_score: minScore, model_mode: modelMode, status: 'pending', created_at: now, updated_at: now });
      } catch { return fail(503, 'Conversation could not be saved. Please try again.'); }
      if (existing) {
        if (existing.conversation_code !== conversationId || existing.question !== question || existing.top_k !== topK || existing.min_score !== minScore || (existing.model_mode ?? 'auto') !== modelMode)
          return fail(409, 'This request_id was already used for a different request.');
        if (existing.status === 'pending') return fail(409, 'This question is still pending. Check conversation history before retrying.');
        return { status: existing.response_status, data: { ...existing.result, conversation_id: conversationId, request_id: requestId } };
      }
      const started = Date.now();
      let response;
      try { response = await send('/ask', { question, top_k: topK, min_score: minScore, model_mode: modelMode }); }
      catch { response = fail(502, 'The agent request failed.'); }
      const successful = response.status === 200;
      const reported = Array.isArray(response.data.token_usage) ? response.data.token_usage : [];
      const usage = reported.map((item, index) => {
        const input = count(item.input_tokens), output = count(item.output_tokens);
        return {
          request_id: requestId, conversation_code: conversationId, call_index: index,
          provider_name: 'ollama', operation: item.operation, model_name: item.model_name,
          input_tokens: input, output_tokens: output,
          total_tokens: input !== null && output !== null ? input + output : null,
          endpoint: '/api/chat', method: 'POST', duration_ms: Date.now() - started,
          status: successful ? 'success' : 'failed', response_status: response.status, created_at: new Date(),
        };
      });
      try {
        await store.finish(requestId, { status: successful ? 'completed' : 'failed',
          result: response.data, response_status: response.status, duration_ms: Date.now() - started, updated_at: new Date() }, usage);
      } catch {
        return fail(503, 'The agent finished, but the answer and usage could not be saved. Check conversation history before retrying.');
      }
      return { status: response.status, data: { ...response.data, conversation_id: conversationId, request_id: requestId } };
    },
    async list() {
      try { return { status: 200, data: { conversations: await store.list() } }; }
      catch { return fail(503, 'Conversation history is unavailable.'); }
    },
    async history(url) {
      const id = url.searchParams.get('conversation_id');
      if (!validId(id)) return fail(400, 'Provide a valid conversation_id.');
      let before;
      try {
        const cursor = url.searchParams.get('before');
        if (cursor) {
          before = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          if (!validId(before.id) || typeof before.created_at !== 'string' || !Number.isFinite(Date.parse(before.created_at))) throw new Error();
        }
      } catch { return fail(400, 'Invalid history cursor.'); }
      try {
        const rows = await store.history(id, before);
        const page = rows.slice(0, 50), last = page.at(-1);
        const next = rows.length > 50 ? Buffer.from(JSON.stringify({ id: last._id, created_at: last.created_at })).toString('base64url') : null;
        const turns = page.reverse().map(row => ({ request_id: row._id, question: row.question,
          status: row.status, created_at: row.created_at, ...(row.result ?? {}) }));
        return { status: 200, data: { conversation_id: id, turns, next_cursor: next } };
      } catch { return fail(503, 'Conversation history is unavailable.'); }
    },
  };
}

export const conversations = createConversationController();
