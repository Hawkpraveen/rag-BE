import { callAgentFile } from '../services/agentClient.js';
import { connectMongoDB, readSQLiteSnapshot, loadDataset } from '../services/mongodbData.js';

export function createUploadHandler({ send = callAgentFile, connect = connectMongoDB,
  snapshot = readSQLiteSnapshot, load = loadDataset } = {}) {
  return async function upload(body) {
    const result = await send('/upload', body.filename, body.content);
    if (result.status !== 200) return result;
    try {
      const dataset = await load(await connect(), await snapshot(), body.datasetId);
      return { status: 200, data: { ...result.data, dataset } };
    } catch {
      return { status: 503, data: { ...result.data,
        detail: 'File indexed locally, but MongoDB publication failed. Check Atlas connectivity and vector index readiness, then run npm run db:load.' } };
    }
  };
}
export const upload = createUploadHandler();
