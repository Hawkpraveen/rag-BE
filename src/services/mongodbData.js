import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseEnv, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../../../', import.meta.url);
const backendRequire = createRequire(new URL('rag-BE/package.json', root));
let client;
let database;

export function parseSettings(source) {
  source = source.replace(/^\uFEFF/, '').trim();
  return /^mongodb(?:\+srv)?:\/\/\S+$/.test(source)
    ? { MONGODB_URI: source } : parseEnv(source);
}

for (const file of ['rag-BE/.env', 'rag-BE/.env.txt']) {
  let source;
  try { source = readFileSync(new URL(file, root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const [key, value] of Object.entries(parseSettings(source))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export async function connectMongoDB() {
  if (database) return database;
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in rag-BE/.env.');
  // Override is useful for testing with an already installed official driver.
  const { MongoClient } = backendRequire(process.env.MONGODB_DRIVER_PATH || 'mongodb');
  const candidate = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000,
  });
  let deadline;
  try {
    await Promise.race([
      (async () => { await candidate.connect(); await candidate.db('admin').command({ ping: 1 }); })(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('timeout')), 15000); }),
    ]);
    client = candidate;
    database = client.db(process.env.MONGODB_DB || 'rag');
    return database;
  } catch (error) {
    await candidate.close().catch(() => {});
    throw new Error(error.code === 18 ? 'MongoDB authentication failed.'
      : 'MongoDB connection failed. Check DNS, Atlas network access and credentials.');
  } finally { clearTimeout(deadline); }
}

export async function closeMongoDB() {
  database = undefined;
  const current = client;
  client = undefined;
  await current?.close();
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateSnapshot(snapshot) {
  if (!Array.isArray(snapshot.documents) || !snapshot.documents.length ||
      !Array.isArray(snapshot.chunks) || !snapshot.chunks.length) {
    throw new Error('The SQLite dataset is empty. Ingest documents with the Python agent first.');
  }
  const sources = new Set(snapshot.documents.map(d => d.source));
  const models = new Set(snapshot.documents.map(d => d.model));
  if (models.size !== 1 || typeof [...models][0] !== 'string' || ![...models][0]) {
    throw new Error('The dataset must use exactly one embedding model. Re-ingest mixed models first.');
  }
  const dimensions = snapshot.chunks[0].vector?.length;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
    throw new Error('Invalid embedding dimensions.');
  }
  for (const chunk of snapshot.chunks) {
    if (!sources.has(chunk.source) || typeof chunk.location !== 'string' ||
        typeof chunk.text !== 'string' || !chunk.text.trim() ||
        !Array.isArray(chunk.vector) || chunk.vector.length !== dimensions ||
        chunk.vector.some(v => typeof v !== 'number' || !Number.isFinite(v)) ||
        !chunk.vector.some(v => v !== 0)) {
      throw new Error('Invalid chunk, non-finite vector or incompatible embedding dimensions.');
    }
  }
  return { model: [...models][0], dimensions };
}

export async function readSQLiteSnapshot() {
  const python = process.env.PYTHON_EXECUTABLE || fileURLToPath(new URL('rag-agent/.venv/Scripts/python.exe', root));
  const dbPath = process.env.RAG_DB || fileURLToPath(new URL('rag-agent/data/index.sqlite3', root));
  const script = `import json,sqlite3,sys
from pathlib import Path
c=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro', uri=True)
c.execute('BEGIN')
documents=[dict(zip(('source','digest','model'),r)) for r in c.execute('SELECT source,digest,model FROM documents ORDER BY source')]
chunks=[{'source':r[0],'location':r[1],'text':r[2],'vector':json.loads(r[3])} for r in c.execute('SELECT source,location,content,vector FROM chunks ORDER BY source,location,content')]
print(json.dumps({'documents':documents,'chunks':chunks}))
c.close()`;
  const { stdout } = await promisify(execFile)(python, ['-c', script, dbPath], {
    maxBuffer: 64 * 1024 * 1024, timeout: 30000, windowsHide: true,
  });
  return JSON.parse(stdout);
}

export async function loadDataset(db, snapshot, datasetId = 'local-documents', options = {}) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(datasetId)) throw new Error('Use a dataset ID of 1-80 letters, digits, underscores or hyphens.');
  const { model, dimensions } = validateSnapshot(snapshot);
  const versionId = hash({ datasetId, ...snapshot });
  const buildId = versionId;
  const indexName = `vectors_${hash({ model, dimensions }).slice(0, 16)}`;
  const now = new Date();
  const chunks = db.collection('chunks');
  const builds = db.collection('index_builds');
  // Deterministic IDs make repeated imports idempotent. Failed builds never change the active dataset.
  await chunks.createIndex({ datasetId: 1, buildId: 1 });
  await db.collection('documents').createIndex({ datasetId: 1, versionId: 1 });
  await db.collection('dataset_versions').updateOne({ _id: versionId }, { $setOnInsert: {
    datasetId, model, dimensions, documents: snapshot.documents, createdAt: now,
  } }, { upsert: true });
  await builds.updateOne({ _id: buildId }, {
    $setOnInsert: { datasetId, versionId, model, dimensions, indexName, createdAt: now },
  }, { upsert: true });
  const prior = await builds.findOne({ _id: buildId });
  try {
    await db.collection('documents').bulkWrite(snapshot.documents.map(document => ({ updateOne: {
      filter: { _id: hash({ datasetId, versionId, source: document.source }) },
      update: { $setOnInsert: { ...document, datasetId, versionId } }, upsert: true,
    } })));
    for (let start = 0; start < snapshot.chunks.length; start += 100) {
      await chunks.bulkWrite(snapshot.chunks.slice(start, start + 100).map((chunk, i) => ({ updateOne: {
        filter: { _id: hash({ buildId, ordinal: start + i }) },
        update: { $setOnInsert: { ...chunk, datasetId, versionId, buildId, model, dimensions } }, upsert: true,
      } })));
    }
    const indexes = await chunks.listSearchIndexes(indexName).toArray();
    if (!indexes.length) {
      await chunks.createSearchIndex({ name: indexName, type: 'vectorSearch', definition: { fields: [
        { type: 'vector', path: 'vector', numDimensions: dimensions, similarity: 'cosine' },
        { type: 'filter', path: 'datasetId' }, { type: 'filter', path: 'buildId' },
      ] } });
    }
    const deadline = Date.now() + (options.waitMS ?? 120000);
    let ready = false;
    do {
      const [index] = await chunks.listSearchIndexes(indexName).toArray();
      if (index?.status === 'FAILED') throw new Error('MongoDB vector index build failed.');
      if (index?.queryable) {
        const hits = await chunks.aggregate([
          { $vectorSearch: { index: indexName, path: 'vector', queryVector: snapshot.chunks[0].vector,
            exact: true, limit: 1, filter: { datasetId, buildId } } },
          { $project: { _id: 1 } },
        ]).toArray();
        if (hits.length) { ready = true; break; }
      }
      if (Date.now() >= deadline) break;
      await delay(2000);
    } while (Date.now() < deadline);
    if (!ready) throw new Error('Vector index is not ready yet. Re-run db:load to resume.');
    const metadata = { datasetId, versionId, buildId, model, dimensions, indexName,
      documentCount: snapshot.documents.length, chunkCount: snapshot.chunks.length };
    await builds.updateOne({ _id: buildId }, { $set: { status: 'ready', readyAt: new Date() } });
    await db.collection('datasets').updateOne({ _id: datasetId }, {
      $set: { ...metadata, status: 'ready', updatedAt: new Date() }, $setOnInsert: { createdAt: now },
    }, { upsert: true });
    return metadata;
  } catch (error) {
    if (prior?.status !== 'ready') await builds.updateOne({ _id: buildId }, {
      $set: { status: 'failed', failedAt: new Date() },
    });
    throw error;
  }
}

export async function listDatasets() {
  const db = await connectMongoDB();
  return db.collection('datasets').find({}, { projection: { documents: 0 } }).toArray();
}
