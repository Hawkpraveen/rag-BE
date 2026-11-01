import { connectMongoDB, readSQLiteSnapshot, loadDataset, listDatasets } from '../services/mongodbData.js';
import { callAgent } from '../services/agentClient.js';

export async function health() {
  const result = await callAgent('/health', undefined, 5000);
  return { status: result.status === 200 ? 200 : 503,
    data: { status: result.status === 200 ? 'ok' : 'degraded', agent: result.status === 200 ? 'ok' : 'unavailable' } };
}

export async function ingest(body) {
  if (typeof body?.path !== 'string' || !body.path.trim()) {
    return { status: 400, data: { detail: 'Provide a local file or folder path.' } };
  }
  const datasetId = body.dataset_id ?? 'local-documents';
  if (typeof datasetId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(datasetId)) {
    return { status: 400, data: { detail: 'Use a dataset_id of 1-80 letters, digits, underscores or hyphens.' } };
  }
  const result = await callAgent('/ingest', { path: body.path.trim() });
  if (result.status !== 200) return result;
  try {
    const dataset = await loadDataset(await connectMongoDB(), await readSQLiteSnapshot(), datasetId);
    return { status: 200, data: { ...result.data, dataset } };
  } catch {
    return { status: 503, data: { detail: 'Local ingestion completed, but MongoDB publication failed. Check Atlas access and vector index readiness, then run npm run db:load.' } };
  }
}

export async function datasets({ list = listDatasets, connect = connectMongoDB } = {}) {
  const db = await connect();
  const collections = await list();
  const result = await Promise.all(collections.map(async dataset => {
    const records = dataset.versionId ? await db.collection('documents').find(
      { datasetId: dataset.datasetId, versionId: dataset.versionId },
      { projection: { _id: 1, source: 1 } },
    ).toArray() : [];
    return { ...dataset, documents: records.map(record => {
      const name = record.source.split(/[\\/]/).pop();
      return { id: String(record._id), name, type: name.includes('.') ? name.split('.').pop().toLowerCase() : 'file' };
    }) };
  }));
  return { status: 200, data: { datasets: result } };
}

export async function question(body, searchOnly = false) {
  const modelMode = body?.model_mode ?? 'auto';
  if (!['auto', 'fast', 'thorough'].includes(modelMode)) return { status: 400, data: { detail: 'Use auto, fast, or thorough model mode.' } };
  if (typeof body?.question !== 'string' || !body.question.trim() || body.question.length > 4000) {
    return { status: 400, data: { detail: 'Provide a question between 1 and 4000 characters.' } };
  }
  // Forward only supported fields. Agent settings and model credentials stay server-side.
  return callAgent(searchOnly ? '/search' : '/ask', {
    question: body.question.trim(), top_k: body.top_k ?? 4, min_score: body.min_score ?? 0.25, model_mode: modelMode,
  });
}
